// Seattle Theatre Group — The Paramount Theatre (includes the Paramount Theatre
// Tower / archive, which is the same building). Shares the scrape in ../lib/stg.js.

import { venueFeed } from '../lib/stg.js';

export const name = 'Seattle Theatre Group — Paramount Theatre';
export const path = '/stg-paramount.ics';

export const generate = venueFeed(name, /paramount/i);
