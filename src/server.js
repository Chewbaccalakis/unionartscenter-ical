// Tiny HTTP server that generates the Union Arts Center iCal feed on demand.
//
// Home Assistant's Remote Calendar integration fetches the feed URL every 24h;
// each fetch triggers a fresh pull from Tessitura. A short in-memory cache
// keeps casual extra hits from hammering the venue's backend.

import http from 'node:http';
import { generateIcs } from './generate.js';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const CALENDAR_PATH = process.env.CALENDAR_PATH || '/unionartscenter.ics';
// Reuse a generated feed for this long before refetching (seconds).
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_SECONDS || 3600) * 1000;
// Optional HTTP basic auth (Home Assistant Remote Calendar supports it).
const AUTH_USER = process.env.CALENDAR_USERNAME || '';
const AUTH_PASS = process.env.CALENDAR_PASSWORD || '';

let cache = { body: null, expires: 0, inflight: null };

// Coalesce concurrent requests onto a single fetch, and serve from cache
// until the TTL expires.
async function getCalendar() {
  const now = Date.now();
  if (cache.body && now < cache.expires) return cache.body;
  if (cache.inflight) return cache.inflight;

  cache.inflight = generateIcs()
    .then((body) => {
      cache = { body, expires: Date.now() + CACHE_TTL_MS, inflight: null };
      return body;
    })
    .catch((err) => {
      cache.inflight = null;
      throw err;
    });
  return cache.inflight;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (url.pathname !== CALENDAR_PATH) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Union Arts Center calendar"',
      'Content-Type': 'text/plain',
    });
    res.end('Unauthorized');
    return;
  }

  try {
    const body = await getCalendar();
    res.writeHead(200, {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="unionartscenter.ics"',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(body);
  } catch (err) {
    console.error('Failed to generate calendar:', err.message);
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Failed to generate calendar: ${err.message}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(
    `Union Arts Center iCal server listening on http://${HOST}:${PORT}${CALENDAR_PATH}`,
  );
});
