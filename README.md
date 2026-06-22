# Union Arts Center → iCal bridge

Union Arts Center sells tickets through Tessitura's **TNEW** platform
(`order.unionartscenter.org`), which does **not** publish a subscribable iCal
feed. Its [`/events`](https://order.unionartscenter.org/events) page renders the
calendar client-side from a JSON endpoint, so there's nothing for Home
Assistant's **Remote Calendar** integration to subscribe to.

This is a tiny **Node server** that bridges the gap. It exposes a single URL
that, when fetched, pulls live data from TNEW and returns a valid RFC 5545
`.ics` feed. Point Home Assistant's Remote Calendar at that URL and you're done —
no cron job, no static file to regenerate, no token to paste.

```
HA Remote Calendar  ──GET──►  this server  ──►  TNEW JSON endpoint
       ◄──────── text/calendar (.ics) ────────
```

## How it works

The `/events` page POSTs to `/api/products/productionseasons` to get its event
list. That endpoint requires an ASP.NET antiforgery token + session cookies, so
on each request the server **bootstraps its own session**:

1. `GET /events` to collect cookies and scrape the `__RequestVerificationToken`.
2. `POST /api/products/productionseasons` with that token + a date range.
3. Convert each `performance` into a `VEVENT` and return the assembled calendar.

Responses are cached in memory (default 1 hour) so casual extra hits don't
hammer the venue's backend; Home Assistant only refreshes every 24h anyway.

Each event gets:

- **SUMMARY** — the performance title (embedded HTML like `<strong>` is stripped)
- **DTSTART / DTEND** — start from the API in `America/Los_Angeles` (with an
  embedded `VTIMEZONE`); end defaults to start + 2h30m since the API gives no
  end time
- **LOCATION** — `Union Arts Center`
- **URL / DESCRIPTION** — the buy-tickets link and on-sale status
- **UID** — `uac-perf-<performanceId>@unionartscenter.org`, stable across fetches
  so Home Assistant never duplicates events

## Running it

Requires Node 20+.

```bash
npm install
npm start
# → Union Arts Center iCal server listening on http://0.0.0.0:3000/unionartscenter.ics
```

Verify it:

```bash
curl http://localhost:3000/unionartscenter.ics
```

### Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `CALENDAR_PATH` | `/unionartscenter.ics` | URL path of the feed |
| `CACHE_TTL_SECONDS` | `3600` | How long to reuse a generated feed before refetching |
| `CALENDAR_USERNAME` | – | If set, require HTTP basic auth |
| `CALENDAR_PASSWORD` | – | Password for basic auth |

Home Assistant's Remote Calendar supports HTTP basic auth, so setting
`CALENDAR_USERNAME` / `CALENDAR_PASSWORD` lets you expose the feed safely.

### One-shot file generation (optional)

If you'd rather host a static file instead of running a server, the same logic
is available as a CLI:

```bash
node src/cli.js -o unionartscenter.ics
```

## Deployment

### Docker

```bash
docker build -t uac-ical .
docker run -d --restart unless-stopped -p 3000:3000 --name uac-ical uac-ical
```

### systemd

`/etc/systemd/system/uac-ical.service`:

```ini
[Unit]
Description=Union Arts Center iCal server
After=network-online.target

[Service]
WorkingDirectory=/path/to/unionartscenter-ical
ExecStart=/usr/bin/node src/server.js
Environment=PORT=3000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now uac-ical
```

## Adding the Remote Calendar in Home Assistant

Requires Home Assistant **2025.4** or newer.

1. **Settings → Devices & Services → Add Integration → Remote Calendar**
2. **Calendar name:** `Union Arts Center`
3. **URL:** where this server is reachable, e.g.
   `http://<host running this server>:3000/unionartscenter.ics`
4. If you set `CALENDAR_USERNAME` / `CALENDAR_PASSWORD`, enter them when prompted.
5. Submit. HA fetches the feed immediately and refreshes it every 24h.

Events appear on the **Calendar** dashboard and as a `calendar.union_arts_center`
entity you can use in automations.

## Troubleshooting

- **502 / `Could not find __RequestVerificationToken`** — the venue's bot
  protection (Incapsula) likely served a challenge page instead of real HTML.
  At this low request volume it's rare; retrying usually succeeds. If it becomes
  persistent the bootstrap step would need a headless browser (Playwright) to
  clear the challenge — open an issue and we can add that path.
- **Empty calendar** — confirm the season has on-sale performances within the
  query window (default −30 to +400 days; adjustable in `src/generate.js`).
- **Duplicate events in HA** — shouldn't happen (UIDs are stable); if you see
  them, delete and re-add the calendar in HA.
