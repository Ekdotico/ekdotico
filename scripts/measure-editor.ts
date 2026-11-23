// The measuring harness of procedure 1 (docs/procedures/01-editor-performance.md; NFR-PE-01, NFR-IC-14).
//
//   node scripts/measure-editor.ts auto     --origin https://… --accounts accounts.json [--minutes 10] [--rate 4] [--loads 20]
//   node scripts/measure-editor.ts seed     --origin https://… --cookies cookies.json --document <id> [--words 5000|50000]
//   node scripts/measure-editor.ts run      --origin https://… --cookies cookies.json --document <id> [--minutes 10] [--rate 4] [--out result.json] [--no-browser] [--collab-url wss://…/collab]
//   node scripts/measure-editor.ts pageload --origin https://… --cookies cookies.json --document <id> [--loads 20] [--out result.json]
//
// `auto` does the whole procedure from an accounts file (scripts/measure/procedure-1.ts). The three below it are
// its steps, one at a time. `cookies.json` is a file outside the repository, mode 0600, of an array of ten strings:
// the Cookie header of each account's session, the first being the account that owns the document and types. The
// cookies are read from that file and nowhere else, and are printed nowhere. `seed` writes the reference document
// into the document (5,000 words, or 50,000 with `--words 50000`: register D296); `run` holds ten connections,
// types, and prints and saves the figures; `pageload` measures the largest contentful paint of the list of
// documents and of the document (register D297) and adds it to the result file `--out` names.
import { readFileSync, statSync } from 'node:fs';
import {
  assertOrigin,
  collabUrlOf,
  DEFAULT_LOADS,
  DEFAULT_RATE,
  pageload,
  run,
  seed,
  WORDS,
} from './measure/commands.ts';
import { auto } from './measure/procedure-1.ts';

function flag(name: string, fallback?: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? process.argv[at + 1] : fallback;
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} is needed.`);
  return value;
}

function cookies(): string[] {
  const path = flag('cookies');
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error('The cookies file is readable by others: chmod 600 it.');
  let list: unknown;
  try {
    list = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('The cookies file is not valid JSON.');
  }
  if (
    !Array.isArray(list) ||
    list.length !== 10 ||
    list.some((each) => typeof each !== 'string' || each === '')
  ) {
    throw new Error('The cookies file holds an array of ten strings.');
  }
  return list as string[];
}

const origin = new URL(flag('origin')).origin;

function target() {
  const collabUrl = flag('collab-url', collabUrlOf(origin));
  assertOrigin(origin, collabUrl);
  return {
    origin,
    collabUrl,
    documentId: flag('document'),
    cookies: cookies(),
  };
}

const commands: Record<string, () => Promise<void>> = {
  async seed() {
    await seed(target(), Number(flag('words', String(WORDS))));
  },
  async run() {
    const { ok } = await run(target(), {
      minutes: Number(flag('minutes', '10')),
      rate: Number(flag('rate', String(DEFAULT_RATE))),
      noBrowser: process.argv.includes('--no-browser'),
      out: flag('out', ''),
    });
    if (!ok) process.exitCode = 1;
  },
  async pageload() {
    const { ok } = await pageload(target(), {
      loads: Number(flag('loads', String(DEFAULT_LOADS))),
      out: flag('out', ''),
    });
    if (!ok) process.exitCode = 1;
  },
  async auto() {
    await auto({
      origin,
      accountsPath: flag('accounts'),
      minutes: Number(flag('minutes', '10')),
      rate: Number(flag('rate', String(DEFAULT_RATE))),
      loads: Number(flag('loads', String(DEFAULT_LOADS))),
    });
  },
};
const command = commands[process.argv[2] ?? ''];
if (!command) {
  console.error(
    'Usage: measure-editor.ts auto|seed|run|pageload --origin … (--accounts … | --cookies … --document …)',
  );
  process.exit(2);
}
await command().catch((error: Error) => {
  console.error(`measure: ${error.message}`);
  process.exit(1);
});
process.exit(process.exitCode ?? 0);
