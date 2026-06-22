// Seattle Theatre Group — The Neptune Theatre. Shares the scrape in ../lib/stg.js.

import { venueFeed } from '../lib/stg.js';

export const name = 'Seattle Theatre Group — Neptune Theatre';
export const path = '/stg-neptune.ics';

export const generate = venueFeed(name, /neptune/i);
