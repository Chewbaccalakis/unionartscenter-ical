// Ties together fetching and calendar building behind a single call.

import { DateTime } from 'luxon';
import { fetchProductionSeasons } from './fetcher.js';
import { buildCalendar } from './calendar.js';

const VENUE_TZ = 'America/Los_Angeles';

// Returns the date window the API should be queried for, as ISO strings with
// the venue's UTC offset (matching what the live page sends).
function defaultWindow({ daysBack = 30, daysAhead = 400 } = {}) {
  const today = DateTime.now().setZone(VENUE_TZ).startOf('day');
  return {
    start: today.minus({ days: daysBack }).toISO(),
    end: today.plus({ days: daysAhead }).endOf('day').toISO(),
  };
}

// Fetch fresh event data and return a serialized iCal string.
async function generateIcs(options = {}) {
  const window = defaultWindow(options);
  const seasons = await fetchProductionSeasons(window);
  const cal = buildCalendar(seasons);
  return cal.toString();
}

export { generateIcs, defaultWindow };
