// Scraper for Union Arts Center (https://order.unionartscenter.org/events).
//
// The site runs on Tessitura's TNEW platform. The /events page renders
// client-side from a JSON endpoint (POST /api/products/productionseasons)
// guarded by an ASP.NET antiforgery token + session cookies. This scraper
// bootstraps its own session — GETs /events to collect cookies and the token,
// then POSTs to the data endpoint — so no manual token pasting is needed.

import { DateTime } from 'luxon';
import { cleanText, cookieHeaderFrom, createCalendar } from '../lib/calendar.js';

export const name = 'Union Arts Center';
export const path = '/unionartscenter.ics';

const BASE_URL = 'https://order.unionartscenter.org';
const EVENTS_PAGE = `${BASE_URL}/events`;
const DATA_ENDPOINT = `${BASE_URL}/api/products/productionseasons`;
const TIMEZONE = 'America/Los_Angeles';
const DEFAULT_DURATION_MINUTES = 150;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

const KEYWORDS = [
  'Mainstage', 'Christmas_Carol', 'Special_Events', 'Post-Play Discussion',
  'ASL_Interpreted', 'Preview', 'Audio_Description', 'Outside_Produced',
  'Tix_For_Teachers', 'Education', 'Community_Night', 'Opening_Night',
];

const TOKEN_RE = /name="__RequestVerificationToken"[^>]*\bvalue="([^"]+)"/;

async function bootstrapSession() {
  const res = await fetch(EVENTS_PAGE, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`GET /events failed: HTTP ${res.status}`);

  const cookie = cookieHeaderFrom(res.headers.getSetCookie());
  const html = await res.text();
  const match = TOKEN_RE.exec(html);
  if (!match) {
    throw new Error(
      'Could not find __RequestVerificationToken in the events page. ' +
      'The layout may have changed, or a bot challenge (Incapsula) blocked the request.',
    );
  }
  return { cookie, token: match[1] };
}

async function fetchSeasons({ start, end }) {
  const { cookie, token } = await bootstrapSession();

  const body = new URLSearchParams();
  body.append('keywordIds', '');
  body.append('startDate', start);
  body.append('endDate', end);
  for (const kw of KEYWORDS) body.append('keywords[]', kw);

  const res = await fetch(DATA_ENDPOINT, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      RequestVerificationToken: token,
      Origin: BASE_URL,
      Referer: EVENTS_PAGE,
      Cookie: cookie,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`POST productionseasons failed: HTTP ${res.status}`);
  return res.json();
}

// generate() is the only function the server calls.
export async function generate() {
  const today = DateTime.now().setZone(TIMEZONE).startOf('day');
  const start = today.minus({ days: 30 }).toISO();
  const end = today.plus({ days: 400 }).endOf('day').toISO();

  const seasons = await fetchSeasons({ start, end });
  const cal = createCalendar({ name, timezone: TIMEZONE });
  const seen = new Set();

  for (const season of seasons ?? []) {
    const productionTitle = cleanText(season.productionTitle);
    const seasonUrl = season.productionSeasonActionUrl || '';

    for (const perf of season.performances ?? []) {
      if (perf.id == null || !perf.performanceDate) continue;

      const uid = `uac-perf-${perf.id}@unionartscenter.org`;
      if (seen.has(uid)) continue;
      seen.add(uid);

      const start = DateTime.fromISO(perf.performanceDate, { setZone: true }).setZone(TIMEZONE);
      if (!start.isValid) continue;

      const summary = cleanText(perf.performanceTitle) || productionTitle || name;
      const url = perf.actionUrl || seasonUrl || undefined;

      const descLines = [];
      const status = (perf.performanceStatusMessage || '').trim();
      if (status) descLines.push(status);
      else if (perf.isOnSale) descLines.push('On sale');
      if (url) descLines.push(url);

      cal.createEvent({
        id: uid,
        start,
        end: start.plus({ minutes: DEFAULT_DURATION_MINUTES }),
        summary,
        location: name,
        url,
        description: descLines.length ? descLines.join('\n') : undefined,
        timezone: TIMEZONE,
      });
    }
  }

  return cal.toString();
}
