// Converts Union Arts Center production-season JSON into an RFC 5545 iCal feed.

import ical from 'ical-generator';
import { getVtimezoneComponent } from '@touch4it/ical-timezones';
import { DateTime } from 'luxon';

const VENUE_TZ = 'America/Los_Angeles';
const VENUE_NAME = 'Union Arts Center';

// The API gives no end time; assume a typical performance length.
const DEFAULT_DURATION_MINUTES = 150;

// Strip embedded HTML tags (e.g. "<strong>Pride Night</strong>") and decode
// the handful of entities that show up in titles.
function cleanText(value) {
  if (!value) return '';
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// Build an ICalCalendar from the production-season array returned by the API.
function buildCalendar(seasons) {
  const cal = ical({
    name: VENUE_NAME,
    prodId: { company: 'unionartscenter-ical', product: 'Union Arts Center' },
    timezone: { name: VENUE_TZ, generator: getVtimezoneComponent },
  });

  const seen = new Set();

  for (const season of seasons ?? []) {
    const productionTitle = cleanText(season.productionTitle);
    const seasonUrl = season.productionSeasonActionUrl || '';

    for (const perf of season.performances ?? []) {
      const id = perf.id;
      const rawDate = perf.performanceDate;
      if (id == null || !rawDate) continue;

      // Stable UID keyed on the immutable performance id so Home Assistant
      // never duplicates events across refreshes.
      const uid = `uac-perf-${id}@unionartscenter.org`;
      if (seen.has(uid)) continue;
      seen.add(uid);

      const start = DateTime.fromISO(rawDate, { setZone: true }).setZone(
        VENUE_TZ,
      );
      if (!start.isValid) continue;
      const end = start.plus({ minutes: DEFAULT_DURATION_MINUTES });

      const summary =
        cleanText(perf.performanceTitle) ||
        productionTitle ||
        'Union Arts Center Event';

      const url = perf.actionUrl || seasonUrl || undefined;

      const descLines = [];
      const status = (perf.performanceStatusMessage || '').trim();
      if (status) descLines.push(status);
      else if (perf.isOnSale) descLines.push('On sale');
      if (url) descLines.push(url);

      cal.createEvent({
        id: uid,
        start,
        end,
        summary,
        location: VENUE_NAME,
        url,
        description: descLines.length ? descLines.join('\n') : undefined,
        timezone: VENUE_TZ,
      });
    }
  }

  return cal;
}

export { buildCalendar };
