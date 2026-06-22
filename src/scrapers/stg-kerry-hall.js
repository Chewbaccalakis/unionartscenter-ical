// Seattle Theatre Group — Kerry Hall (STG's education center).
// Shares the scrape in ../lib/stg.js.

import { venueFeed } from '../lib/stg.js';

export const name = 'Seattle Theatre Group — Kerry Hall';
export const path = '/stg-kerry-hall.ics';

export const generate = venueFeed(name, /kerry/i);
