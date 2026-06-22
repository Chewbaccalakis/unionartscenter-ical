// Multi-calendar iCal server.
//
// At startup, every file in src/scrapers/ is loaded as a plugin. Each scraper
// must export:
//
//   export const name = 'Human-readable name';
//   export const path = '/feed-path.ics';        // URL path this feed is served at
//   export async function generate() { ... }     // returns an iCal string
//
// Dropping a new file into src/scrapers/ is all that's needed to add a feed.

import http from 'node:http';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 3600) * 1000;

// Optional global HTTP basic auth.
const AUTH_USER = process.env.CALENDAR_USERNAME || '';
const AUTH_PASS = process.env.CALENDAR_PASSWORD || '';

// Load every .js file from src/scrapers/ and return an array of scraper modules.
async function loadScrapers() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'scrapers');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  return Promise.all(
    files.map((f) => import(join(dir, f))),
  );
}

// Per-scraper in-memory cache. Coalesces concurrent requests onto one fetch
// and reuses the result until CACHE_TTL_MS expires.
function makeCache(generate) {
  let body = null;
  let expires = 0;
  let inflight = null;

  return async function get() {
    const now = Date.now();
    if (body && now < expires) return body;
    if (inflight) return inflight;

    inflight = generate()
      .then((result) => {
        body = result;
        expires = Date.now() + CACHE_TTL_MS;
        inflight = null;
        return body;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });
    return inflight;
  };
}

function authorized(req) {
  if (!AUTH_USER && !AUTH_PASS) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const [user, pass] = Buffer.from(header.slice(6), 'base64')
    .toString('utf8')
    .split(':');
  return user === AUTH_USER && pass === AUTH_PASS;
}

// Simple HTML index listing every registered feed.
function indexPage(scrapers) {
  const host = `http://localhost:${PORT}`;
  const rows = scrapers
    .map((s) => `  <li><a href="${s.path}">${s.name}</a> — <code>${host}${s.path}</code></li>`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Calendar feeds</title></head>
<body>
<h1>Calendar feeds</h1>
<ul>
${rows}
</ul>
</body>
</html>`;
}

async function main() {
  const scrapers = await loadScrapers();

  if (scrapers.length === 0) {
    console.warn('No scrapers found in src/scrapers/ — add a .js file to get started.');
  }

  // Build a route map: path → { scraper, getCalendar }
  const routes = new Map();
  for (const scraper of scrapers) {
    if (!scraper.name || !scraper.path || typeof scraper.generate !== 'function') {
      console.warn(`Skipping invalid scraper (missing name, path, or generate):`, scraper);
      continue;
    }
    routes.set(scraper.path, { scraper, getCalendar: makeCache(scraper.generate) });
    console.log(`Registered: ${scraper.name} → ${scraper.path}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indexPage(scrapers));
      return;
    }

    const route = routes.get(pathname);
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    if (!authorized(req)) {
      res.writeHead(401, {
        'WWW-Authenticate': `Basic realm="${route.scraper.name} calendar"`,
        'Content-Type': 'text/plain',
      });
      res.end('Unauthorized');
      return;
    }

    try {
      const body = await route.getCalendar();
      const filename = pathname.split('/').pop();
      res.writeHead(200, {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(body);
    } catch (err) {
      console.error(`[${route.scraper.name}] Failed to generate calendar:`, err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Failed to generate calendar: ${err.message}`);
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`Listening on http://${HOST}:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
