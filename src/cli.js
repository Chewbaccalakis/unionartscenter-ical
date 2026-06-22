// One-shot iCal generation for testing or static hosting.
//
//   node src/cli.js                        # list available scrapers
//   node src/cli.js unionartscenter        # print feed to stdout
//   node src/cli.js unionartscenter -o out.ics

import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'scrapers');

async function loadAll() {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.js'));
  return Promise.all(files.map((f) => import(join(dir, f))));
}

async function main() {
  const args = process.argv.slice(2);
  const scraperArg = args.find((a) => !a.startsWith('-'));
  let output = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') output = args[++i];
  }

  const scrapers = await loadAll();

  if (!scraperArg) {
    console.log('Available scrapers:');
    for (const s of scrapers) console.log(`  ${s.path.replace('/', '').replace('.ics', '')}  →  ${s.name}`);
    console.log('\nUsage: node src/cli.js <scraper-name> [-o output.ics]');
    return;
  }

  const scraper = scrapers.find(
    (s) =>
      s.path.includes(scraperArg) ||
      s.name.toLowerCase().includes(scraperArg.toLowerCase()),
  );
  if (!scraper) {
    console.error(`No scraper found matching "${scraperArg}"`);
    process.exit(1);
  }

  console.error(`Generating: ${scraper.name}`);
  const ics = await scraper.generate();

  if (output) {
    await writeFile(output, ics);
    console.error(`Wrote ${output}`);
  } else {
    process.stdout.write(ics);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
