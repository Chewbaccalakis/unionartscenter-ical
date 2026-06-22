// Seattle Theatre Group — The Moore Theatre. Shares the scrape in ../lib/stg.js.

import { venueFeed } from '../lib/stg.js';

export const name = 'Seattle Theatre Group — Moore Theatre';
export const path = '/stg-moore.ics';

export const generate = venueFeed(name, /\bmoore\b/i);
