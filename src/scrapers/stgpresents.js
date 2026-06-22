// Scraper for Seattle Theatre Group (https://www.stgpresents.org/calendar/).
//
// STG runs WordPress + Modern Events Calendar (MEC), fronted by SiteGround's
// proof-of-work bot challenge. This scraper bootstraps its own access, much
// like the Union Arts Center one:
//
//   1. Clearance — GET /calendar/. If SiteGround answers with its JavaScript
//      proof-of-work challenge instead of the page, solve it (a SHA1 hash
//      search) and submit the solution to obtain the clearance cookie. A real
//      browser does this transparently; here we replay the same math in Node.
//   2. Config — scrape the MEC monthly skin's serialized `atts` blob out of the
//      cleared page. MEC's AJAX month loader needs it to know what to query.
//   3. Events — page month by month through MEC's admin-ajax endpoint
//      (action=mec_monthly_view_load_month), collecting the per-event
//      schema.org JSON-LD that MEC embeds in every calendar grid cell.
//
// Time quirk: MEC's JSON-LD prints the local wall-clock time but tags it with
// the site's UTC offset (a long-standing MEC bug), so a 1:00 PM show is emitted
// as "...T06:00:00-07:00" (i.e. 13:00 UTC). We recover the real local time by
// taking the UTC wall-clock of the instant and re-stamping it in TIMEZONE.

import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { cleanText, createCalendar } from '../lib/calendar.js';

export const name = 'Seattle Theatre Group';
export const path = '/stgpresents.ics';

const BASE_URL = 'https://www.stgpresents.org';
const CALENDAR_PAGE = `${BASE_URL}/calendar/`;
const AJAX_ENDPOINT = `${BASE_URL}/wp-admin/admin-ajax.php`;
const TIMEZONE = 'America/Los_Angeles';
const MONTHS_AHEAD = 14; // current month + 13 ahead — STG schedules ~13 months out
const DEFAULT_DURATION_MINUTES = 180;
const POW_BUDGET = 50_000_000; // hash attempts before giving up (typical solve ~2M)

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

// A request carrying this header (or a bare 202) is SiteGround's bot challenge.
function isChallenge(res) {
  return res.headers.get('sg-captcha') === 'challenge' || res.status === 202;
}

// --- Stateful session: a tiny cookie jar shared across every request. ---
function createSession() {
  const jar = new Map();

  function store(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  async function request(url, init = {}) {
    const res = await fetch(url, {
      redirect: 'manual', // capture Set-Cookie on every hop ourselves
      ...init,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'en-US,en;q=0.9',
        ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(init.headers || {}),
      },
    });
    store(res);
    return res;
  }

  return { request };
}

// --- SiteGround proof-of-work solver. ---
//
// The challenge string is "<complexity>:<timestamp>:<...>". We search for a
// counter such that SHA1(challengeBytes ++ counterBytes) has `complexity`
// leading zero bits in its first 32-bit word; the solution submitted back is
// the base64 of that winning (challenge ++ counter) byte string.

function counterBytes(n) {
  let len = 1;
  if (n > 0xffffff) len = 4;
  else if (n > 0xffff) len = 3;
  else if (n > 0xff) len = 2;
  const buf = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i--) {
    buf[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return buf;
}

function solveProofOfWork(challenge) {
  const complexity = parseInt(challenge.split(':', 1)[0], 10);
  if (!Number.isInteger(complexity)) throw new Error('Unrecognized SiteGround challenge');
  const shift = 32 - complexity;
  const challengeBytes = Buffer.from(challenge, 'utf8');

  for (let counter = 0; counter < POW_BUDGET; counter++) {
    const input = Buffer.concat([challengeBytes, counterBytes(counter)]);
    const word0 = crypto.createHash('sha1').update(input).digest().readUInt32BE(0);
    if (word0 !== 0 && word0 >>> shift === 0) return input.toString('base64');
  }
  throw new Error('SiteGround proof-of-work exceeded budget');
}

// Walk SiteGround's challenge: meta-refresh → challenge page → solve → submit.
// On success the clearance cookie lands in the session jar.
async function clearChallenge(session, challengeHtml) {
  const refresh = challengeHtml.match(/content="0;([^"]+)"/);
  if (!refresh) throw new Error('SiteGround challenge: no redirect found');
  const challengeUrl = new URL(refresh[1].replace(/&amp;/g, '&'), CALENDAR_PAGE).toString();

  const page = await (await session.request(challengeUrl, { headers: { Referer: CALENDAR_PAGE } })).text();
  const challenge = page.match(/sgchallenge="([^"]+)"/);
  const submitUrl = page.match(/sgsubmit_url="([^"]+)"/);
  if (!challenge || !submitUrl) throw new Error('SiteGround challenge page not recognized');

  const solution = solveProofOfWork(challenge[1]);
  const submit =
    new URL(submitUrl[1], challengeUrl).toString() +
    (submitUrl[1].includes('?') ? '&' : '?') +
    `sol=${encodeURIComponent(solution)}&s=1:1`;
  await session.request(submit, { headers: { Referer: challengeUrl } });
}

// GET the calendar page, transparently clearing the bot challenge if present.
async function fetchCalendarPage(session) {
  const htmlHeaders = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

  let res = await session.request(CALENDAR_PAGE, { headers: htmlHeaders });
  if (isChallenge(res)) {
    await clearChallenge(session, await res.text());
    res = await session.request(CALENDAR_PAGE, { headers: htmlHeaders });
  }
  if (!res.ok) throw new Error(`GET /calendar/ failed: HTTP ${res.status}`);
  return res.text();
}

// Pull the MEC monthly skin's serialized shortcode config (already URL-encoded
// as atts[...]=...) out of its inline init call. The AJAX loader needs it.
function extractAtts(html) {
  const init = html.indexOf('mecMonthlyView(');
  if (init === -1) {
    throw new Error('Could not find the MEC monthly calendar on /calendar/ — layout may have changed');
  }
  const segment = html.slice(init, html.indexOf('</script>', init));
  const match = segment.match(/atts:\s*"([^"]+)"/);
  if (!match) throw new Error('Could not extract MEC skin config (atts) from the calendar page');
  return match[1];
}

// Load one month of the calendar and return its rendered HTML.
async function fetchMonth(session, atts, year, month) {
  const body =
    `action=mec_monthly_view_load_month&mec_year=${year}` +
    `&mec_month=${String(month).padStart(2, '0')}&${atts}&apply_sf_date=1`;

  const res = await session.request(AJAX_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      Origin: BASE_URL,
      Referer: CALENDAR_PAGE,
    },
    body,
  });
  if (!res.ok) throw new Error(`Load ${year}-${month} failed: HTTP ${res.status}`);
  const json = await res.json();
  return json.month || '';
}

// Extract the schema.org Event JSON-LD blocks MEC embeds per grid cell.
function parseEvents(monthHtml) {
  const events = [];
  const re = /<script type="application\/ld\+json">(.*?)<\/script>/gs;
  let m;
  while ((m = re.exec(monthHtml))) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    if (data && data['@type'] === 'Event' && data.startDate) events.push(data);
  }
  return events;
}

// Decode a MEC JSON-LD date. Timed values carry the wall-clock-as-UTC quirk;
// date-only values are treated as all-day in TIMEZONE.
function decodeDate(iso) {
  if (!iso) return null;
  if (!iso.includes('T')) {
    const day = DateTime.fromISO(iso, { zone: TIMEZONE });
    return day.isValid ? { dt: day.startOf('day'), allDay: true } : null;
  }
  const instant = DateTime.fromISO(iso, { setZone: true });
  if (!instant.isValid) return null;
  const u = instant.toUTC();
  const local = DateTime.fromObject(
    { year: u.year, month: u.month, day: u.day, hour: u.hour, minute: u.minute, second: u.second },
    { zone: TIMEZONE },
  );
  return { dt: local, allDay: false };
}

function slugFromUrl(url) {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
  } catch {
    return '';
  }
}

// generate() is the only function the server calls.
export async function generate() {
  const session = createSession();
  const html = await fetchCalendarPage(session);
  const atts = extractAtts(html);

  const cal = createCalendar({ name, timezone: TIMEZONE });
  const seen = new Set();
  const firstMonth = DateTime.now().setZone(TIMEZONE).startOf('month');

  for (let i = 0; i < MONTHS_AHEAD; i++) {
    const month = firstMonth.plus({ months: i });
    const monthHtml = await fetchMonth(session, atts, month.year, month.month);

    for (const data of parseEvents(monthHtml)) {
      const start = decodeDate(data.startDate);
      if (!start) continue;

      const url = data.offers?.url || data.url || undefined;
      const uid = `stg-${slugFromUrl(url) || 'event'}-${start.dt.toFormat('yyyyMMdd')}@stgpresents.org`;
      if (seen.has(uid)) continue; // events spanning a month boundary appear twice
      seen.add(uid);

      let end;
      if (start.allDay) {
        end = start.dt.plus({ days: 1 });
      } else {
        const endDecoded = decodeDate(data.endDate);
        end =
          endDecoded && !endDecoded.allDay && endDecoded.dt > start.dt
            ? endDecoded.dt
            : start.dt.plus({ minutes: DEFAULT_DURATION_MINUTES });
      }

      const loc = data.location || {};
      const location = [cleanText(loc.name), cleanText(loc.address)].filter(Boolean).join(', ') || name;

      const descLines = [];
      const blurb = cleanText(data.description).replace(/\s+/g, ' ').trim();
      if (blurb) descLines.push(blurb.length > 600 ? `${blurb.slice(0, 599)}…` : blurb);
      if (url) descLines.push(url);

      cal.createEvent({
        id: uid,
        start: start.dt,
        end,
        allDay: start.allDay,
        summary: cleanText(data.name) || name,
        location,
        url,
        description: descLines.length ? descLines.join('\n\n') : undefined,
        timezone: TIMEZONE,
      });
    }
  }

  return cal.toString();
}
