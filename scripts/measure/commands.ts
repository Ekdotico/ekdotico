// The three steps of procedure 1 (docs/procedures/01-editor-performance.md; NFR-PE-01, NFR-IC-14) as functions,
// for the command line (scripts/measure-editor.ts) and for the runner that does the whole procedure
// (scripts/measure/procedure-1.ts). Each takes its target and its ten Cookie headers as values: where the cookies
// come from is the caller's business, and none is printed here.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { countWords, referenceDocument, WORDS } from '../../tests/fixtures/reference-document.ts';
import { browserTypist } from './browser.ts';
import {
  connect,
  connectionTypist,
  FRAGMENT,
  fillFragment,
  measure,
  Receiver,
  type Result,
} from './harness.ts';
import { largestContentfulPaints } from './page-load.ts';
import { DEFAULT_LOADS, DEFAULT_RATE, pageLoadReport } from './plan.ts';

export { DEFAULT_LOADS, DEFAULT_RATE, WORDS };

export interface Target {
  origin: string;
  collabUrl: string;
  documentId: string;
  /** The Cookie header of each of ten accounts, the first being the owner of the document, which types. */
  cookies: readonly string[];
}

/** The `collab` address that serves an origin: the same host, on the web socket scheme. */
export const collabUrlOf = (origin: string) => `${origin.replace(/^http/, 'ws')}/collab`;

/** Cookies and passwords go to an origin, so it is https, except on a machine's own localhost, and the collaboration address is on its host. */
export function assertOrigin(origin: string, collabUrl: string = collabUrlOf(origin)): void {
  const { protocol, hostname } = new URL(origin);
  if (protocol !== 'https:' && !(protocol === 'http:' && ['localhost', '127.0.0.1'].includes(hostname)))
    throw new Error('--origin must use https, except on localhost: cookies and passwords are sent to it.');
  if (new URL(collabUrl).host !== new URL(origin).host)
    throw new Error('The collaboration address must be on the host of --origin: cookies are sent to it.');
}

/** Writes the reference document of `words` words into an empty document, and waits until the server has it. */
export async function seed(
  target: Target,
  words: number = WORDS,
): Promise<{ blocks: number; words: number }> {
  if (!Number.isInteger(words) || words < 100) throw new Error('--words is a whole number of at least 100.');
  const reference = referenceDocument(words);
  const owner = await connect(target.collabUrl, target.origin, target.cookies[0]!, target.documentId);
  const fragment = owner.document.getXmlFragment(FRAGMENT);
  if (fragment.length > 0) throw new Error('The document is not empty: seed an empty one.');
  owner.document.transact(() => fillFragment(fragment, reference as never));
  // Held open until the server has the change.
  const until = Date.now() + 15_000;
  while (owner.provider.hasUnsyncedChanges && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (owner.provider.hasUnsyncedChanges)
    throw new Error('The server did not take the document within 15 seconds.');
  owner.close();
  const done = { blocks: fragment.length, words: countWords(reference) };
  console.log(`seed: wrote ${done.blocks} blocks, ${done.words} words`);
  return done;
}

export interface RunOptions {
  minutes: number;
  rate: number;
  noBrowser?: boolean;
  /** A file to write the result to, mode 0600. */
  out?: string;
}

/** Holds ten connections, types, and prints and saves the figures. `ok` is false where a change was not seen. */
export async function run(
  target: Target,
  options: RunOptions,
): Promise<{ result: Result & { madeAt: string; minutes: number; tool: string }; ok: boolean }> {
  const { minutes, rate, noBrowser = false, out } = options;
  if (!(minutes > 0) || !(rate > 0)) throw new Error('--minutes and --rate are positive numbers.');
  const { origin, collabUrl, documentId, cookies } = target;

  // The typist first: its page is loaded before the receivers read the end of the paragraph.
  const typistConnection = noBrowser ? await connect(collabUrl, origin, cookies[0]!, documentId) : null;
  const typist = typistConnection
    ? connectionTypist(typistConnection)
    : await browserTypist({ origin, cookie: cookies[0]!, documentId });
  const receivers: Receiver[] = [];
  try {
    for (const cookie of cookies.slice(1))
      receivers.push(new Receiver(await connect(collabUrl, origin, cookie, documentId)));
    const held = receivers.length + 1;
    console.log(`run: ${held} connections held`);
    if (held !== 10) throw new Error('Not all ten connections are held; the run does not go on.');
    const result = await measure({ receivers, typist, keystrokes: Math.round(minutes * 60 * rate), rate });
    const made = {
      madeAt: new Date().toISOString(),
      minutes,
      tool: noBrowser ? 'connection typist' : 'chromium',
      ...result,
    };
    if (out) writeFileSync(out, `${JSON.stringify(made, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(made, null, 2));
    const ok = result.propagationMissing === 0 && result.keystrokesNotFound === 0;
    if (!ok) console.error('run: some changes were not seen; repeat the run.');
    return { result: made, ok };
  } finally {
    await typist.close();
    for (const receiver of receivers) receiver.connection.close();
  }
}

/** The page-load step: the P75 of the largest contentful paint of each page, written under `pageLoad` of `out`. */
export async function pageload(
  target: Target,
  options: { loads?: number; out?: string } = {},
): Promise<{ pageLoad: Record<string, unknown>; ok: boolean }> {
  const loads = options.loads ?? DEFAULT_LOADS;
  if (!Number.isInteger(loads) || loads < 1) throw new Error('--loads is a positive whole number.');
  const pages: Record<string, string> = {
    'list of documents': '/',
    'reference document': `/documents/${target.documentId}`,
  };
  const report: Record<string, unknown> = {};
  for (const [name, path] of Object.entries(pages))
    report[name] = pageLoadReport(
      await largestContentfulPaints({ origin: target.origin, cookie: target.cookies[0]!, path, loads }),
    );
  const pageLoad = { madeAt: new Date().toISOString(), tool: 'chromium', loads, pages: report };
  const file = options.out ?? '';
  if (file !== '') {
    const previous = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as object) : {};
    writeFileSync(file, `${JSON.stringify({ ...previous, pageLoad }, null, 2)}\n`, { mode: 0o600 });
  }
  console.log(JSON.stringify(pageLoad, null, 2));
  const ok = Object.values(report).every((each) => (each as { met: boolean }).met);
  if (!ok) console.error('pageload: a page is not under its budget.');
  return { pageLoad, ok };
}
