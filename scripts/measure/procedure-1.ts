// The runner of procedure 1 (docs/procedures/01-editor-performance.md; NFR-PE-01, register D295 to D297): after the
// accounts exist, one command does the rest.
//
//   node scripts/measure-editor.ts auto --origin https://… --accounts /path/outside/the/repository/accounts.json
//
// `accounts.json` (mode 0600, outside the repository) holds
//   { "owner": { "email", "password" },
//     "testers": [ nine of { "email", "password" } or { "email", "invitationLink" } ] }
// An entry with an `invitationLink` is signed up through the application's own route (POST /api/sign-up, FR-AU-90)
// with a generated password, which is written back into the file, and the link with it removed. All ten sign in
// through the identity library's route; the owner's account is asked for its code of two-factor authentication on
// the terminal. The ten Cookie headers are held in memory and written nowhere. Then the two documents are made
// and shared, and the three steps of scripts/measure/commands.ts run on them, the same functions the commands
// `seed`, `run` and `pageload` call.
//
// The script contacts the `--origin` it is given, and its `/collab` on the same host, and nothing else. It prints no
// password, cookie, token or link. It stops at the first failure and says which step it was.
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { chromium } from '@playwright/test';
import { assertOrigin, collabUrlOf, pageload, run, seed, type Target } from './commands.ts';

// ── The accounts file ───────────────────────────────────────────────────────

export interface Tester {
  email: string;
  password?: string;
  /** Present while the account is not yet signed up. */
  invitationLink?: string;
}
export interface Accounts {
  owner: { email: string; password: string };
  testers: Tester[];
}

const TESTERS = 9;
const REPOSITORY = resolve(import.meta.dirname, '..', '..');
const text = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Reads the file; refuses one that is readable by others, or inside the repository, or not of the shape. */
export function loadAccounts(path: string, repository: string = REPOSITORY): Accounts {
  // The real paths, with symlinks followed and the case of the file system folded (APFS), so that neither hides a file in the repository.
  const fold = (value: string) => (process.platform === 'linux' ? value : value.toLowerCase());
  const full = realpathSync(resolve(path));
  const inside = existsSync(repository) ? realpathSync(repository) : resolve(repository);
  if (fold(full).startsWith(fold(inside) + sep))
    throw new Error('The accounts file is inside the repository: keep it outside.');
  // One open file, checked and read: nothing changes between the check and the read.
  const descriptor = openSync(full, 'r');
  let content: string;
  try {
    const stat = fstatSync(descriptor);
    if ((stat.mode & 0o077) !== 0) throw new Error('The accounts file is readable by others: chmod 600 it.');
    if (stat.nlink > 1) throw new Error('The accounts file has another name (a hard link): keep one.');
    if (process.getuid && stat.uid !== process.getuid()) throw new Error('The accounts file is not yours.');
    if ((statSync(dirname(full)).mode & 0o022) !== 0)
      throw new Error('The folder of the accounts file can be written by others: chmod go-w it.');
    content = readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  let file: Partial<Accounts> | null;
  try {
    file = JSON.parse(content) as Partial<Accounts> | null;
  } catch {
    // The library's message quotes the text near the fault, which here may be a password.
    throw new Error('The accounts file is not valid JSON.');
  }
  const owner = file?.owner;
  if (!owner || !text(owner.email) || !text(owner.password))
    throw new Error('The accounts file needs "owner" with an email and a password.');
  const testers = file?.testers;
  if (!Array.isArray(testers) || testers.length !== TESTERS)
    throw new Error(`The accounts file needs "testers": exactly ${TESTERS} accounts.`);
  testers.forEach((each: Partial<Tester> | null, at) => {
    const label = `tester ${at + 1}`;
    if (!each || !text(each.email)) throw new Error(`${label} needs an email.`);
    if (!text(each.password) && !text(each.invitationLink))
      throw new Error(`${label} needs a password, or an invitationLink to sign up with.`);
  });
  const emails = [owner.email, ...testers.map((each) => each.email)].map((each) => each.toLowerCase());
  if (new Set(emails).size !== emails.length) throw new Error('Two accounts have the same email.');
  return { owner: { email: owner.email, password: owner.password }, testers: testers as Tester[] };
}

/** Written whole to a file of its own and renamed over the first, mode 0600, so that a password is never half written. */
export function saveAccounts(path: string, accounts: Accounts): void {
  const full = resolve(path);
  const next = `${full}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    // Exclusive: a name that exists, a link planted there included, is refused. Flushed before the rename.
    const descriptor = openSync(next, 'wx', 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(accounts, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(next, full);
  } catch (error) {
    try {
      unlinkSync(next);
    } catch {
      // Not written: nothing to remove.
    }
    throw error;
  }
}

/** A password of 24 characters from the system's random source: inside the application's limits (8 to 32). */
export const generatedPassword = (): string => randomBytes(18).toString('base64url');

// ── The session ─────────────────────────────────────────────────────────────

/** The cookies of one account, from the `Set-Cookie` lines of the answers, in memory. */
export class Jar {
  private readonly cookies = new Map<string, string>();

  absorb(headers: Headers): void {
    for (const line of headers.getSetCookie()) {
      const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
      const at = pair.indexOf('=');
      if (at < 1) continue;
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const gone = attributes.some((attribute) => {
        const [key = '', rest = ''] = attribute.split('=');
        if (key.toLowerCase() === 'max-age') return Number(rest) <= 0;
        if (key.toLowerCase() === 'expires') return Date.parse(rest) < Date.now();
        return false;
      });
      if (gone || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  /** The `Cookie` header; the cookie of a sign-in's second step is left out of what is kept as the session. */
  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  session(): string {
    return [...this.cookies]
      .filter(([name]) => !name.includes('two_factor'))
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

/** What the routes answer, as far as the runner reads it. */
export interface Reply {
  twoFactorRedirect?: boolean;
  id?: string;
  error?: { code?: string };
  people?: number;
  collaborators?: { role: string }[];
  invitations?: { id: string; email: string }[];
  currentVersion?: number;
  acknowledgedVersion?: number | null;
}
export interface Answer {
  status: number;
  json: Reply | null;
  retryAfter?: string;
}

/**
 * NFR-SE-07: the requests of a person without a session (sign-up, sign-in, the second step) are limited for each network
 * address, 20 in a minute (`SESSIONLESS_PER_ADDRESS`, src/lib/settings.ts). The runner makes 20 of them from one address, so
 * it waits where it must, and stays under the limit with room to spare (15). It does not retry a refusal.
 */
export class Pacer {
  private readonly times: number[] = [];
  private readonly max: number;
  private readonly windowMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    max = 15,
    windowMs = 60_000,
    sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
  ) {
    this.max = max;
    this.windowMs = windowMs;
    this.sleep = sleep;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.times.length > 0 && this.times[0]! <= now - this.windowMs) this.times.shift();
      if (this.times.length < this.max) {
        this.times.push(now);
        return;
      }
      await this.sleep(this.times[0]! + this.windowMs - now + 250);
    }
  }
}

const sessionless = (path: string) => path.startsWith('/api/sign-up') || path.startsWith('/api/auth/');

export class Client {
  readonly jar = new Jar();
  readonly origin: string;
  private readonly send: typeof fetch;
  private readonly pacer: Pacer | undefined;
  constructor(origin: string, send: typeof fetch = fetch, pacer?: Pacer) {
    this.origin = origin;
    this.send = send;
    this.pacer = pacer;
  }

  /** One request to the origin, as a browser of the application sends it. The answer's body is read as JSON where it is. */
  async request(method: string, path: string, body?: unknown): Promise<Answer> {
    if (sessionless(path)) await this.pacer?.take();
    const cookie = this.jar.header();
    const response = await this.send(this.origin + path, {
      method,
      redirect: 'error',
      headers: {
        Origin: this.origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.jar.absorb(response.headers);
    let json: Reply | null = null;
    try {
      json = await response.json();
    } catch {
      // No JSON body.
    }
    const retryAfter = response.headers.get('retry-after') ?? undefined;
    return { status: response.status, json, retryAfter };
  }
}

/** The class of a refusal, for a message: the status and the code of the error, never the text, which may quote an address. */
const refusal = (answer: Answer): string =>
  `${answer.status}${typeof answer.json?.error?.code === 'string' ? ` ${answer.json.error.code}` : ''}${answer.status === 429 && answer.retryAfter ? `, a limit of the application: try again in ${answer.retryAfter} seconds` : ''}`;

/** The token of an invitation link of this origin: its last path segment, after `/sign-up/`. */
export function tokenOf(link: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new Error('An invitation link is not an address.');
  }
  const match = /^\/sign-up\/([^/]+)$/.exec(url.pathname);
  if (url.origin !== origin || !match)
    throw new Error('An invitation link is not a sign-up link of the origin.');
  return decodeURIComponent(match[1]!);
}

/** FR-AU-90: signs one account up from its invitation. The password is written to the file before the request. */
export async function signUp(
  client: Client,
  accounts: Accounts,
  index: number,
  save: () => void,
): Promise<void> {
  const tester = accounts.testers[index]!;
  const token = tokenOf(tester.invitationLink!, client.origin);
  tester.password ??= generatedPassword();
  // A fault after the server has the account must not lose the password.
  save();
  const answer = await client.request('POST', '/api/sign-up', {
    token,
    name: `Perf tester ${index + 1}`,
    password: tester.password,
  });
  // An invitation that is not open may be one a run before this used, whose password is kept: sign-in decides.
  if (answer.status !== 201 && answer.json?.error?.code !== 'invitation_not_open')
    throw new Error(`sign-up of tester ${index + 1} was refused (${refusal(answer)})`);
  delete tester.invitationLink;
  save();
}

/** Asks for the six digits on the terminal. */
export async function askCode(): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (
      await lines.question('Six-digit code of two-factor authentication for the owner account: ')
    ).trim();
  } finally {
    lines.close();
  }
}

/** Signs in through the identity library, and through the second step where the account asks for it. */
export async function signIn(
  client: Client,
  who: { email: string; password: string },
  label: string,
  code: () => Promise<string> = askCode,
): Promise<string> {
  const first = await client.request('POST', '/api/auth/sign-in/email', {
    email: who.email,
    password: who.password,
  });
  if (first.status !== 200) throw new Error(`sign-in of ${label} was refused (${refusal(first)})`);
  if (first.json?.twoFactorRedirect === true) {
    const digits = await code();
    if (!/^\d{6}$/.test(digits)) throw new Error('The code is six digits.');
    const second = await client.request('POST', '/api/auth/two-factor/verify-totp', { code: digits });
    if (second.status !== 200) throw new Error(`the code of ${label} was refused (${refusal(second)})`);
  }
  const cookie = client.jar.session();
  if (cookie === '') throw new Error(`sign-in of ${label} left no session`);
  return cookie;
}

// ── The documents and their people ──────────────────────────────────────────

/**
 * FR-AU-55, FR-AU-56: an account that has acknowledged nothing sees the Closed α notice in place of every page, so the
 * typing browser would never reach the editor. The account's own acknowledgement of the current version, through the
 * application's route, as the button "Continue" sends it; one already given is left as it is.
 */
export async function acknowledgeNotice(client: Client, label: string): Promise<void> {
  const state = await client.request('GET', '/api/account/closed-alpha-notice');
  const current = state.json?.currentVersion;
  if (state.status !== 200 || typeof current !== 'number')
    throw new Error(`the notice of ${label} could not be read (${refusal(state)})`);
  if (typeof state.json?.acknowledgedVersion === 'number' && state.json.acknowledgedVersion >= current)
    return;
  const done = await client.request('POST', '/api/account/closed-alpha-notice/acknowledgement', {
    version: current,
  });
  if (done.status !== 200) throw new Error(`the notice of ${label} was not acknowledged (${refusal(done)})`);
}

export async function makeDocument(owner: Client, title: string): Promise<string> {
  const made = await owner.request('POST', '/api/documents', {});
  if (made.status !== 201 || typeof made.json?.id !== 'string')
    throw new Error(`the document "${title}" was not made (${refusal(made)})`);
  const named = await owner.request('PATCH', `/api/documents/${made.json.id}`, { title });
  if (named.status !== 200) throw new Error(`the document "${title}" was not named (${refusal(named)})`);
  return made.json.id;
}

/** Invites the nine as Editor; each accepts by the identifier of its invitation, which the owner's list of people holds. */
export async function shareDocument(
  owner: Client,
  testers: { email: string; client: Client }[],
  documentId: string,
): Promise<number> {
  const invited = await owner.request('POST', `/api/documents/${documentId}/invitations`, {
    emails: testers.map((each) => each.email),
    role: 'editor',
  });
  if (invited.status !== 201) throw new Error(`the invitations were refused (${refusal(invited)})`);
  const pending = (await owner.request('GET', `/api/documents/${documentId}/collaborators`)).json
    ?.invitations;
  for (const [at, tester] of testers.entries()) {
    const found = pending?.find((each) => each.email.toLowerCase() === tester.email.toLowerCase());
    if (!found) throw new Error(`no invitation is pending for tester ${at + 1}`);
    const answer = await tester.client.request('POST', `/api/invitations/received/${found.id}/accept`);
    if (answer.status >= 300) throw new Error(`tester ${at + 1} could not accept (${refusal(answer)})`);
  }
  const list = await owner.request('GET', `/api/documents/${documentId}/collaborators`);
  const sharing = list.json;
  const editors = sharing?.collaborators?.filter((each) => each.role.toLowerCase() === 'editor').length;
  if (
    list.status !== 200 ||
    sharing?.people !== 10 ||
    editors !== TESTERS ||
    (sharing.invitations ?? []).length > 0
  )
    throw new Error(`the document does not have ten people (it has ${sharing?.people})`);
  return sharing.people;
}

// ── The figures the checklist asks for ──────────────────────────────────────

const ms = (value: number) => `${Math.round(value * 10) / 10} ms`;

function printFigures(
  label: string,
  words: number,
  people: number,
  ran: Awaited<ReturnType<typeof run>>,
): void {
  const { result } = ran;
  const per = result.perReceiver.map((each) => each.n);
  console.log(
    [
      `── ${label} ──`,
      `words in the document: ${words}; people listed: ${people}; connections held: ${result.connections}`,
      `rate: ${result.rate} a second; length of the run: ${result.minutes} minutes (${result.seconds} s); keystrokes typed: ${result.typed}`,
      `keystrokes measured: ${result.keystroke?.n ?? 0}; not found in the page: ${result.keystrokesNotFound}`,
      `changes measured for each receiver: ${Math.min(...per)} to ${Math.max(...per)}; missing: ${result.propagationMissing}`,
      `keystroke to render: P50 ${ms(result.keystroke?.p50 ?? NaN)}, P99 ${ms(result.keystroke?.p99 ?? NaN)}`,
      `propagation to a collaborator: P50 ${ms(result.propagation.p50)}, P99 ${ms(result.propagation.p99)}`,
    ].join('\n'),
  );
}

// ── The whole procedure ─────────────────────────────────────────────────────

export interface AutoOptions {
  origin: string;
  accountsPath: string;
  minutes: number;
  rate: number;
  loads: number;
  /** For the tests: the network, the terminal, the repository, the steps, and the browser's version. */
  send?: typeof fetch;
  code?: () => Promise<string>;
  repository?: string;
  steps?: { seed: typeof seed; run: typeof run; pageload: typeof pageload };
  chromiumVersion?: () => Promise<string>;
  pacer?: Pacer;
}

async function browserVersion(): Promise<string> {
  const browser = await chromium.launch();
  try {
    return browser.version();
  } finally {
    await browser.close();
  }
}

/** A step that failed says which it was. */
async function step<T>(name: string, work: () => Promise<T>): Promise<T> {
  console.log(`auto: ${name}`);
  try {
    return await work();
  } catch (error) {
    throw new Error(`step "${name}" failed: ${(error as Error).message}`, { cause: error });
  }
}

export async function auto(options: AutoOptions): Promise<void> {
  const { origin, minutes, rate, loads } = options;
  assertOrigin(origin);
  const steps = options.steps ?? { seed, run, pageload };
  const dir = dirname(resolve(options.accountsPath));
  const collabUrl = collabUrlOf(origin);

  const accounts = await step('read the accounts file', async () =>
    loadAccounts(options.accountsPath, options.repository),
  );
  const chromiumVersion = await step('start the browser', options.chromiumVersion ?? browserVersion);

  const pacer = options.pacer ?? new Pacer();
  const owner = new Client(origin, options.send, pacer);
  const testers = accounts.testers.map((each) => ({
    email: each.email,
    client: new Client(origin, options.send, pacer),
  }));

  for (const [at, tester] of accounts.testers.entries()) {
    if (!tester.invitationLink) continue;
    await step(`sign up tester ${at + 1}`, () =>
      signUp(testers[at]!.client, accounts, at, () => saveAccounts(options.accountsPath, accounts)),
    );
  }

  const cookies: string[] = [];
  cookies.push(
    await step('sign in the owner', () => signIn(owner, accounts.owner, 'the owner', options.code)),
  );
  for (const [at, tester] of accounts.testers.entries())
    cookies.push(
      await step(`sign in tester ${at + 1}`, () =>
        signIn(testers[at]!.client, { email: tester.email, password: tester.password! }, `tester ${at + 1}`),
      ),
    );

  await step('acknowledge the Closed α notice of the ten accounts', async () => {
    await acknowledgeNotice(owner, 'the owner');
    for (const [at, tester] of testers.entries()) await acknowledgeNotice(tester.client, `tester ${at + 1}`);
  });

  const reference = async (title: string, words: number, withLoad: boolean) => {
    const documentId = await step(`make the document "${title}"`, () => makeDocument(owner, title));
    const people = await step(`share "${title}" with nine editors`, () =>
      shareDocument(owner, testers, documentId),
    );
    return { documentId, people, words, withLoad };
  };
  const small = await reference('Perf 5k', 5000, true);
  const large = await reference('Perf 50k', 50000, false);

  const target = (documentId: string): Target => ({ origin, collabUrl, documentId, cookies });
  const figures: Record<string, string> = {};
  for (const each of [small, large]) {
    const label = `${each.words} words`;
    const out = join(dir, each.words === 5000 ? 'result-5k.json' : 'result-50k.json');
    const seeded = await step(`seed ${label}`, () => steps.seed(target(each.documentId), each.words));
    const ran = await step(`run ${label} (${minutes} minutes)`, async () => {
      const done = await steps.run(target(each.documentId), { minutes, rate, out });
      if (!done.ok) throw new Error('some changes were not seen; the result is in the file, repeat the run');
      return done;
    });
    printFigures(label, seeded.words, each.people, ran);
    figures[label] = out;
    if (each.withLoad) {
      const loaded = await step('page load of the 5,000-word document', () =>
        steps.pageload(target(each.documentId), { loads, out }),
      );
      for (const [name, page] of Object.entries(
        loaded.pageLoad.pages as Record<string, { loads: number; p75: number; met: boolean }>,
      ))
        console.log(
          `page load, ${name}: ${page.loads} loads, P75 ${ms(page.p75)}${page.met ? '' : ' (over the budget)'}`,
        );
    }
  }
  console.log(`tools: Chromium ${chromiumVersion}; Node.js ${process.version}`);
  console.log(`result files: ${Object.values(figures).join(', ')}`);
}
