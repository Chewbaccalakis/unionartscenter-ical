#!/usr/bin/env python3
"""
Union Arts Center -> iCal bridge.

The venue runs on Tessitura's TNEW platform, which does not publish a
subscribable iCal feed. Its /events page fetches event data client-side from a
JSON endpoint (POST /api/products/productionseasons). This script reproduces
that request, then converts the returned production/performance data into a
valid RFC 5545 .ics file suitable for Home Assistant's "Remote Calendar"
integration.

The endpoint is protected by an ASP.NET antiforgery token pair and session
cookies. Rather than ask the user to paste tokens, the script bootstraps its
own session: it GETs /events first to collect cookies + the antiforgery token,
then POSTs to the data endpoint with those credentials.

Usage:
    python3 uac_ical.py --output /config/www/unionartscenter.ics

See README.md for scheduling and Home Assistant setup.
"""

import argparse
import datetime as dt
import logging
import re
import sys
from html import unescape
from zoneinfo import ZoneInfo

import requests
from icalendar import Calendar, Event

LOG = logging.getLogger("uac_ical")

BASE_URL = "https://order.unionartscenter.org"
EVENTS_PAGE = f"{BASE_URL}/events"
DATA_ENDPOINT = f"{BASE_URL}/api/products/productionseasons"

VENUE_TZ = ZoneInfo("America/Los_Angeles")
VENUE_NAME = "Union Arts Center"

# A real browser User-Agent helps avoid trivial bot filtering.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) "
    "Gecko/20100101 Firefox/128.0"
)

# Keyword filters the live /events page sends. Sending the full set returns
# every category of event (mainstage, special events, etc.).
KEYWORDS = [
    "Mainstage",
    "Christmas_Carol",
    "Special_Events",
    "Post-Play Discussion",
    "ASL_Interpreted",
    "Preview",
    "Audio_Description",
    "Outside_Produced",
    "Tix_For_Teachers",
    "Education",
    "Community_Night",
    "Opening_Night",
]

# No end time is provided by the API; assume a typical performance length.
DEFAULT_EVENT_DURATION = dt.timedelta(hours=2, minutes=30)

# Antiforgery token rendered as a hidden form field in the page HTML.
_TOKEN_RE = re.compile(
    r'name="__RequestVerificationToken"[^>]*\bvalue="([^"]+)"'
)
_HTML_TAG_RE = re.compile(r"<[^>]+>")


def clean_text(value: str) -> str:
    """Strip embedded HTML tags/entities from a title (e.g. <strong>...)."""
    if not value:
        return ""
    return unescape(_HTML_TAG_RE.sub("", value)).strip()


def build_session() -> requests.Session:
    """Create a session primed with cookies + the antiforgery token.

    Returns the session; the matched token value is stashed on the session as
    ``session.verification_token`` for the caller to send as a header.
    """
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
        }
    )

    LOG.info("Bootstrapping session via %s", EVENTS_PAGE)
    resp = session.get(EVENTS_PAGE, timeout=30)
    resp.raise_for_status()

    match = _TOKEN_RE.search(resp.text)
    if not match:
        raise RuntimeError(
            "Could not find __RequestVerificationToken in the events page. "
            "The page layout may have changed, or a bot challenge (Incapsula) "
            "blocked the request."
        )
    session.verification_token = match.group(1)
    LOG.info("Acquired antiforgery token and %d cookies",
             len(session.cookies))
    return session


def fetch_production_seasons(session: requests.Session,
                             start: dt.datetime,
                             end: dt.datetime) -> list:
    """POST to the TNEW data endpoint and return the parsed JSON list."""
    payload = [
        ("keywordIds", ""),
        ("startDate", start.isoformat()),
        ("endDate", end.isoformat()),
    ]
    payload += [("keywords[]", kw) for kw in KEYWORDS]

    headers = {
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "RequestVerificationToken": session.verification_token,
        "Origin": BASE_URL,
        "Referer": EVENTS_PAGE,
    }

    LOG.info("Requesting events from %s to %s", start.date(), end.date())
    resp = session.post(DATA_ENDPOINT, data=payload, headers=headers,
                        timeout=30)
    resp.raise_for_status()
    return resp.json()


def parse_offset_datetime(value: str) -> dt.datetime:
    """Parse an ISO 8601 datetime that includes a UTC offset."""
    return dt.datetime.fromisoformat(value)


def build_calendar(seasons: list) -> Calendar:
    """Convert production-season JSON into an icalendar Calendar."""
    cal = Calendar()
    cal.add("prodid", "-//unionartscenter-ical//Union Arts Center//EN")
    cal.add("version", "2.0")
    cal.add("calscale", "GREGORIAN")
    cal.add("method", "PUBLISH")
    cal.add("x-wr-calname", "Union Arts Center")
    cal.add("x-wr-timezone", "America/Los_Angeles")

    now = dt.datetime.now(dt.timezone.utc)
    count = 0
    seen_uids = set()

    for season in seasons:
        production_title = clean_text(season.get("productionTitle", ""))
        season_url = season.get("productionSeasonActionUrl") or ""

        for perf in season.get("performances", []):
            perf_id = perf.get("id")
            raw_date = perf.get("performanceDate")
            if perf_id is None or not raw_date:
                LOG.warning("Skipping performance with missing id/date: %r",
                            perf)
                continue

            # Stable UID keyed on the immutable performance id so HA does not
            # duplicate events across regenerations.
            uid = f"uac-perf-{perf_id}@unionartscenter.org"
            if uid in seen_uids:
                continue
            seen_uids.add(uid)

            try:
                start = parse_offset_datetime(raw_date).astimezone(VENUE_TZ)
            except ValueError:
                LOG.warning("Unparseable date %r for perf %s; skipping",
                            raw_date, perf_id)
                continue
            end = start + DEFAULT_EVENT_DURATION

            title = clean_text(perf.get("performanceTitle", "")) \
                or production_title or "Union Arts Center Event"

            event = Event()
            event.add("uid", uid)
            event.add("summary", title)
            event.add("dtstart", start)
            event.add("dtend", end)
            event.add("dtstamp", now)
            event.add("location", VENUE_NAME)

            url = perf.get("actionUrl") or season_url
            if url:
                event.add("url", url)

            description_parts = []
            status_msg = (perf.get("performanceStatusMessage") or "").strip()
            if status_msg:
                description_parts.append(status_msg)
            elif perf.get("isOnSale"):
                description_parts.append("On sale")
            if url:
                description_parts.append(url)
            if description_parts:
                event.add("description", "\n".join(description_parts))

            cal.add_component(event)
            count += 1

    # Embed a VTIMEZONE component so stricter parsers can resolve TZID.
    cal.add_missing_timezones()

    LOG.info("Built calendar with %d events", count)
    return cal


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", "-o", default="unionartscenter.ics",
        help="Path to write the .ics file (default: unionartscenter.ics)",
    )
    parser.add_argument(
        "--days-back", type=int, default=30,
        help="Include events starting this many days before today "
             "(default: 30)",
    )
    parser.add_argument(
        "--days-ahead", type=int, default=400,
        help="Include events up to this many days ahead (default: 400)",
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Verbose logging",
    )
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(asctime)s %(levelname)s %(message)s",
    )

    today = dt.datetime.now(VENUE_TZ).replace(
        hour=0, minute=0, second=0, microsecond=0)
    start = today - dt.timedelta(days=args.days_back)
    end = (today + dt.timedelta(days=args.days_ahead)).replace(
        hour=23, minute=59, second=59)

    try:
        session = build_session()
        seasons = fetch_production_seasons(session, start, end)
    except requests.RequestException as exc:
        LOG.error("Network error contacting Union Arts Center: %s", exc)
        return 1
    except (RuntimeError, ValueError) as exc:
        LOG.error("%s", exc)
        return 1

    cal = build_calendar(seasons)

    data = cal.to_ical()
    # Write atomically so HA never reads a half-written file.
    tmp_path = f"{args.output}.tmp"
    with open(tmp_path, "wb") as fh:
        fh.write(data)
    import os
    os.replace(tmp_path, args.output)
    LOG.info("Wrote %d bytes to %s", len(data), args.output)
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
