// One-shot generation to stdout or a file, for testing or static hosting.
//
//   node src/cli.js              # print .ics to stdout
//   node src/cli.js -o cal.ics   # write to a file

import { writeFile } from 'node:fs/promises';
import { generateIcs } from './generate.js';

async function main() {
  const args = process.argv.slice(2);
  let output = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o' || args[i] === '--output') output = args[++i];
  }

  const ics = await generateIcs();
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
