# Union Arts Center → iCal bridge

Union Arts Center sells tickets through Tessitura's **TNEW** platform
(`order.unionartscenter.org`), which does **not** publish a subscribable iCal
feed. Its [`/events`](https://order.unionartscenter.org/events) page renders the
calendar client-side from a JSON endpoint, so there's nothing for Home
Assistant's **Remote Calendar** integration to subscribe to.

This repo bridges that gap: `uac_ical.py` reproduces the page's data request,
converts the events into a valid RFC 5545 `.ics` file, and you host that file
somewhere Home Assistant can reach. Run it on a daily schedule and the feed
stays current.

```
TNEW JSON endpoint  ──►  uac_ical.py  ──►  unionartscenter.ics  ──►  HA Remote Calendar
```

## How it works

The `/events` page POSTs to `/api/products/productionseasons` to get its event
list. That endpoint requires an ASP.NET antiforgery token + session cookies, so
the script **bootstraps its own session**:

1. `GET /events` to collect cookies and scrape the `__RequestVerificationToken`.
2. `POST /api/products/productionseasons` with that token + a date range.
3. Convert each `performance` into a `VEVENT`.

You never have to paste tokens or cookies — they're acquired automatically on
each run.

Each event gets:

- **SUMMARY** — the performance title (embedded HTML like `<strong>` is stripped)
- **DTSTART / DTEND** — start from the API (`America/Los_Angeles`); end defaults
  to start + 2h30m since the API gives no end time
- **LOCATION** — `Union Arts Center`
- **URL / DESCRIPTION** — the buy-tickets link and on-sale status
- **UID** — `uac-perf-<performanceId>@unionartscenter.org`, stable across runs so
  Home Assistant never duplicates events

## Setup

```bash
pip install -r requirements.txt
python3 uac_ical.py --output unionartscenter.ics
```

Options:

| Flag | Default | Meaning |
|------|---------|---------|
| `--output` / `-o` | `unionartscenter.ics` | Where to write the file |
| `--days-back` | `30` | Include events starting this many days before today |
| `--days-ahead` | `400` | Include events up to this many days ahead |
| `--verbose` / `-v` | off | Log progress to stderr |

## Hosting the file for Home Assistant

### Option A — HA's `www/` folder (simplest)

Write the file into Home Assistant's config directory:

```bash
python3 uac_ical.py --output /config/www/unionartscenter.ics
```

It's then served at `http://<your-ha-host>:8123/local/unionartscenter.ics`
(create the `www` folder if it doesn't exist; a restart is needed the first time
the folder is created).

### Option B — any static web server

Drop `unionartscenter.ics` in any directory served over HTTP(S) (nginx, Caddy,
`python3 -m http.server`, etc.) and point HA at that URL.

## Scheduling daily regeneration

A theater season changes slowly, so once a day is plenty.

### cron

```cron
# 4:15 AM daily
15 4 * * * cd /path/to/unionartscenter-ical && /usr/bin/python3 uac_ical.py -o /config/www/unionartscenter.ics >> /var/log/uac_ical.log 2>&1
```

### systemd timer

`/etc/systemd/system/uac-ical.service`:

```ini
[Unit]
Description=Generate Union Arts Center iCal feed

[Service]
Type=oneshot
WorkingDirectory=/path/to/unionartscenter-ical
ExecStart=/usr/bin/python3 uac_ical.py -o /config/www/unionartscenter.ics
```

`/etc/systemd/system/uac-ical.timer`:

```ini
[Unit]
Description=Run Union Arts Center iCal feed daily

[Timer]
OnCalendar=*-*-* 04:15:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl enable --now uac-ical.timer
```

### Home Assistant `shell_command`

If you run HA OS / Supervised and want HA itself to regenerate the file, add to
`configuration.yaml`:

```yaml
shell_command:
  update_uac_calendar: "python3 /config/uac_ical.py -o /config/www/unionartscenter.ics"
```

…and call `shell_command.update_uac_calendar` from a daily time-triggered
automation. (Requires `requests` and `icalendar` to be importable in HA's
Python environment; the cron/systemd options avoid that constraint.)

## Adding the Remote Calendar in Home Assistant

Requires Home Assistant **2025.4** or newer.

1. **Settings → Devices & Services → Add Integration → Remote Calendar**
2. **Calendar name:** `Union Arts Center`
3. **URL:** the hosted `.ics` URL from above (e.g.
   `http://homeassistant.local:8123/local/unionartscenter.ics`)
4. Submit. HA fetches the feed immediately and refreshes it every 24h.

Events appear on the **Calendar** dashboard and as a `calendar.union_arts_center`
entity you can use in automations.

## Troubleshooting

- **`Could not find __RequestVerificationToken`** — the venue's bot protection
  (Incapsula) likely served a challenge page instead of the real HTML. At
  once-a-day volume this is rare; re-running usually succeeds. If it becomes
  persistent, the bootstrap step would need a headless browser (Playwright) to
  clear the challenge — open an issue and we can add that path.
- **No events / empty calendar** — widen the window with `--days-ahead`, or
  confirm the season has on-sale performances in range.
- **Duplicate events in HA** — shouldn't happen (UIDs are stable), but if you
  manually edited UIDs, delete and re-add the calendar.
