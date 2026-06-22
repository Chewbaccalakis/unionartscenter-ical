// Seattle Theatre Group — overall feed (every event, all venues).
//
// The scraping itself lives in ../lib/stg.js, which is shared with the
// per-venue feeds (stg-paramount.js, stg-neptune.js, stg-moore.js,
// stg-kerry-hall.js) so all five share a single scrape per refresh.

import { SITE_NAME, venueFeed } from '../lib/stg.js';

export const name = SITE_NAME;
export const path = '/stgpresents.ics';

export const generate = venueFeed(name);
