// The measuring harness of procedure 1 (docs/procedures/01-editor-performance.md; NFR-PE-01, NFR-IC-14).
//
//   node scripts/measure-editor.ts seed --origin https://… --cookies cookies.json --document <id>
//   node scripts/measure-editor.ts run  --origin https://… --cookies cookies.json --document <id> [--minutes 10] [--rate 6] [--out result.json] [--no-browser] [--collab-url wss://…/collab]
//
// `cookies.json` is a file outside the repository, mode 0600, of an array of ten strings: the Cookie header of
// each account's session, the first being the account that owns the document and types. The cookies are read
// from that file and nowhere else, and are printed nowhere. `seed` writes the reference document into the
// document; `run` holds ten connections, types, and prints and saves the figures.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import referenceDocument from '../tests/fixtures/reference-document.json' with { type: 'json' };
import { browserTypist } from './measure/browser.ts';
import { connect, connectionTypist, FRAGMENT, fillFragment, measure, Receiver } from './measure/harness.ts';

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
  const list: unknown = JSON.parse(readFileSync(path, 'utf8'));
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
const collabUrl = flag('collab-url', `${origin.replace(/^http/, 'ws')}/collab`);
const documentId = flag('document');

async function seed(): Promise<void> {
  const owner = await connect(collabUrl, origin, cookies()[0]!, documentId);
  const fragment = owner.document.getXmlFragment(FRAGMENT);
  if (fragment.length > 0) throw new Error('The document is not empty: seed an empty one.');
  owner.document.transact(() => fillFragment(fragment, referenceDocument as never));
  // Held open until the server has the change.
  const until = Date.now() + 15_000;
  while (owner.provider.hasUnsyncedChanges && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (owner.provider.hasUnsyncedChanges)
    throw new Error('The server did not take the document within 15 seconds.');
  const words = referenceDocument.content.reduce(
    (sum, block) =>
      sum +
      block.content
        .map((part) => part.text)
        .join(' ')
        .split(/\s+/)
        .filter(Boolean).length,
    0,
  );
  owner.close();
  console.log(`seed: wrote ${fragment.length} blocks, ${words} words`);
}

async function run(): Promise<void> {
  const list = cookies();
  const minutes = Number(flag('minutes', '10'));
  const rate = Number(flag('rate', '6'));
  if (!(minutes > 0) || !(rate > 0)) throw new Error('--minutes and --rate are positive numbers.');
  const noBrowser = process.argv.includes('--no-browser');

  // The typist first: its page is loaded before the receivers read the end of the paragraph.
  const typistConnection = noBrowser ? await connect(collabUrl, origin, list[0]!, documentId) : null;
  const typist = typistConnection
    ? connectionTypist(typistConnection)
    : await browserTypist({ origin, cookie: list[0]!, documentId });
  const receivers: Receiver[] = [];
  try {
    for (const cookie of list.slice(1))
      receivers.push(new Receiver(await connect(collabUrl, origin, cookie, documentId)));
    const held = receivers.length + 1;
    console.log(`run: ${held} connections held`);
    if (held !== 10) throw new Error('Not all ten connections are held; the run does not go on.');
    const result = await measure({ receivers, typist, keystrokes: Math.round(minutes * 60 * rate), rate });
    const out = {
      madeAt: new Date().toISOString(),
      minutes,
      tool: noBrowser ? 'connection typist' : 'chromium',
      ...result,
    };
    if (flag('out', '') !== '')
      writeFileSync(flag('out'), `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(out, null, 2));
    if (result.propagationMissing > 0 || result.keystrokesNotFound > 0) {
      console.error('run: some changes were not seen; repeat the run.');
      process.exitCode = 1;
    }
  } finally {
    await typist.close();
    for (const receiver of receivers) receiver.connection.close();
  }
}

const commands: Record<string, () => Promise<void>> = { seed, run };
const command = commands[process.argv[2] ?? ''];
if (!command) {
  console.error('Usage: measure-editor.ts seed|run --origin … --cookies … --document …');
  process.exit(2);
}
await command().catch((error: Error) => {
  console.error(`measure: ${error.message}`);
  process.exit(1);
});
process.exit(process.exitCode ?? 0);
