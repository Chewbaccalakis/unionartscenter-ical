// Shared helpers for building RFC 5545 iCal feeds.
//
// Scrapers import createCalendar() to get a pre-configured ICalCalendar, then
// call cal.createEvent() for each event and return cal.toString().

import ical from 'ical-generator';
import { getVtimezoneComponent } from '@touch4it/ical-timezones';

// Strip embedded HTML tags and decode common entities that appear in titles.
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

// Collapse a Set-Cookie header list into a single Cookie request header value.
function cookieHeaderFrom(setCookies) {
  return setCookies
    .map((c) => c.split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

// Return a new ICalCalendar pre-configured with name, prodId, and VTIMEZONE.
function createCalendar({ name, timezone }) {
  return ical({
    name,
    prodId: { company: 'calendar-scraper', product: name },
    timezone: { name: timezone, generator: getVtimezoneComponent },
  });
}

export { cleanText, cookieHeaderFrom, createCalendar };
