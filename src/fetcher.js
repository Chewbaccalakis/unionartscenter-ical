// Retrieves event data from Union Arts Center's Tessitura TNEW backend.
//
// The public /events page renders client-side from a JSON endpoint
// (POST /api/products/productionseasons) that is guarded by an ASP.NET
// antiforgery token plus session cookies. Rather than require pasted tokens,
// this module bootstraps its own session: it GETs /events to collect the
// cookies and scrape the matching antiforgery token, then POSTs to the data
// endpoint with those credentials.

const BASE_URL = 'https://order.unionartscenter.org';
const EVENTS_PAGE = `${BASE_URL}/events`;
const DATA_ENDPOINT = `${BASE_URL}/api/products/productionseasons`;

// A real browser User-Agent avoids trivial bot filtering.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) ' +
  'Gecko/20100101 Firefox/128.0';

// Keyword filters the live /events page sends. The full set returns every
// category of event (mainstage, special events, etc.).
const KEYWORDS = [
  'Mainstage',
  'Christmas_Carol',
  'Special_Events',
  'Post-Play Discussion',
  'ASL_Interpreted',
  'Preview',
  'Audio_Description',
  'Outside_Produced',
  'Tix_For_Teachers',
  'Education',
  'Community_Night',
  'Opening_Night',
];

const TOKEN_RE =
  /name="__RequestVerificationToken"[^>]*\bvalue="([^"]+)"/;

// Collapse a Set-Cookie list into a single Cookie request header.
function cookieHeaderFrom(setCookies) {
  return setCookies
    .map((c) => c.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

// GET /events, returning { cookie, token } for the subsequent POST.
async function bootstrapSession() {
  const res = await fetch(EVENTS_PAGE, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) {
    throw new Error(`GET /events failed: HTTP ${res.status}`);
  }

  const cookie = cookieHeaderFrom(res.headers.getSetCookie());
  const html = await res.text();
  const match = TOKEN_RE.exec(html);
  if (!match) {
    throw new Error(
      'Could not find __RequestVerificationToken in the events page. ' +
        'The layout may have changed, or a bot challenge (Incapsula) blocked ' +
        'the request.',
    );
  }
  return { cookie, token: match[1] };
}

// POST to the data endpoint and return the parsed production-season array.
async function fetchProductionSeasons({ start, end } = {}) {
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
  if (!res.ok) {
    throw new Error(`POST productionseasons failed: HTTP ${res.status}`);
  }
  return res.json();
}

export { fetchProductionSeasons, BASE_URL };
