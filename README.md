# ical-scraper

A Node server that scrapes event calendars from websites that don't publish
iCal feeds, and serves them as RFC 5545 `.ics` endpoints for Home Assistant's
[Remote Calendar](https://www.home-assistant.io/integrations/remote_calendar/)
integration (or any other iCal-compatible client).

Each website is a self-contained **scraper plugin** — a single file in
`src/scrapers/`. The server auto-discovers them at startup and registers a feed
URL for each. Adding a new site means adding one file; nothing else changes.

```
HA Remote Calendar  ──GET──►  this server  ──►  scraper plugin  ──►  website
       ◄──────── text/calendar (.ics) ────────
```

## Current scrapers

| Feed path | Site |
|-----------|------|
| `/unionartscenter.ics` | [Union Arts Center](https://order.unionartscenter.org/events) |

## Adding a new scraper

Create `src/scrapers/<sitename>.js` and export three things:

```js
export const name = 'My Venue';           // human-readable name (used in logs + index)
export const path = '/myvenue.ics';       // URL path this feed is served at

export async function generate() {
  // Fetch event data from the site however needed, build an iCal string,
  // and return it. Use the shared helpers from ../lib/calendar.js.
  const cal = createCalendar({ name, timezone: 'America/Los_Angeles' });
  cal.createEvent({ ... });
  return cal.toString();
}
```

Restart the server — the new feed is live. The index page at `/` lists all
registered feeds automatically.

### Shared helpers (`src/lib/calendar.js`)

| Export | Use |
|--------|-----|
| `createCalendar({ name, timezone })` | Returns a pre-configured `ICalCalendar` with embedded `VTIMEZONE` |
| `cleanText(str)` | Strips HTML tags and decodes common entities from event titles |
| `cookieHeaderFrom(setCookies)` | Collapses `Set-Cookie` header array into a `Cookie` header string |

## How the Union Arts Center scraper works

The `/events` page POSTs to `/api/products/productionseasons`, guarded by an
ASP.NET antiforgery token + session cookies. The scraper **bootstraps its own
session**: GETs `/events` to collect cookies and scrape the token, then POSTs
to the data endpoint. You never have to paste tokens — they're acquired
automatically on each request.

## Setup

Requires Node 20+.

```bash
npm install
npm start
# → Registered: Union Arts Center → /unionartscenter.ics
# → Listening on http://0.0.0.0:3000
```

Visit `http://localhost:3000` for an index of all feeds.

### Configuration (environment variables)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `CACHE_TTL_SECONDS` | `3600` | How long to reuse a generated feed before re-fetching |
| `CALENDAR_USERNAME` | – | If set, require HTTP basic auth for all feeds |
| `CALENDAR_PASSWORD` | – | Password for basic auth |

### One-shot file generation

```bash
node src/cli.js                         # list available scrapers
node src/cli.js unionartscenter         # print feed to stdout
node src/cli.js unionartscenter -o out.ics
```

## Deployment

### Docker

```bash
docker compose up -d
```

`docker-compose.yml` defaults to the published image (`ghcr.io/chewbaccalakis/ical-scraper:latest`). To build locally, swap to the commented `build: .` line.

### systemd

`/etc/systemd/system/ical-scraper.service`:

```ini
[Unit]
Description=ical-scraper
After=network-online.target

[Service]
WorkingDirectory=/path/to/this-repo
ExecStart=/usr/bin/node src/server.js
Environment=PORT=3000
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ical-scraper
```

## Adding to Home Assistant

Requires Home Assistant **2025.4** or newer.

1. **Settings → Devices & Services → Add Integration → Remote Calendar**
2. **Calendar name:** e.g. `Union Arts Center`
3. **URL:** `http://<host>:3000/unionartscenter.ics`
4. Submit — HA fetches immediately and refreshes every 24h.

## Troubleshooting

- **502 on a feed** — the scraper failed to fetch from the source site. Check
  logs for the error message. For UAC specifically: the Incapsula bot-protection
  layer occasionally serves a JS challenge instead of real HTML; re-running
  usually succeeds. If persistent, a Playwright-based bootstrap can be added.
- **Empty calendar** — the scraper ran but found no events in the date window.
  Verify the site has upcoming events and the scraper's date range covers them.
- **Duplicate events in HA** — UIDs are stable by design; this shouldn't happen.
  If it does, delete and re-add the calendar in HA.
