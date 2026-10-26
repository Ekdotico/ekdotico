// The page of a fault of the server, as a production build serves it
// (NFR-SE-06, A10; the owner's decision of 12 October 2026 on its reference).
//
// A fault is made without a line of the application written for it: the build
// that the other tests drive is started a second time, on a port of its own,
// with a database that is not there. A page that reads the database then
// faults as it would in a deployment whose database is down.
import { spawn, type ChildProcess } from 'node:child_process';
import { expect, test } from './fixtures.ts';
import { APP_PORT, AUTH_SECRET } from './origin.ts';

// Past the application's port and the collaboration server's (./origin.ts).
const PORT = String(Number(APP_PORT) + 2);
const ORIGIN = `http://127.0.0.1:${PORT}`;

// The fixed texts, written out here and not taken from the code under test.
const STATEMENT =
  'The request could not complete because of a fault on the server. Nothing was changed. Try again in a few minutes.';
const QUOTE = 'Quote this reference when you report the fault.';
const POLICY =
  /^default-src 'self'; script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'; style-src 'self' 'nonce-\1'; style-src-attr 'unsafe-inline'; img-src 'self'(?: http:\/\/localhost:[0-9]+)?; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/;

let server: ChildProcess | undefined;
/** Everything the server wrote: its log. */
let log = '';

test.beforeAll(async () => {
  const child = spawn('node', ['node_modules/next/dist/bin/next', 'start', '-p', PORT], {
    env: {
      ...process.env,
      FOUNDING_TEAM_EMAILS: '',
      APP_ORIGIN: ORIGIN,
      // Port 1 of this machine: nothing listens there, and the connection is refused at once.
      DATABASE_URL: 'postgresql://ekdotico_app:not-a-password@127.0.0.1:1/nowhere',
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      AUTH_SECRET,
      ADMISSION_SECRET: process.env.E2E_ADMISSION_SECRET,
      EMAIL_SINK_DIRECTORY: process.env.E2E_EMAIL_SINK,
      // As for the first server (playwright.config.ts): the count of requests
      // without a session is kept in Valkey, which the two share.
      RATE_LIMIT_SESSIONLESS_PER_ADDRESS: '100000/60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server = child;
  // Without the colours the runner asks every process under it to write in.
  const written = (chunk: unknown) => (log += String(chunk).replace(/\u001b\[[0-9;]*m/g, ''));
  child.stdout!.on('data', written);
  child.stderr!.on('data', written);
  let exited = false;
  child.once('exit', () => (exited = true));
  await expect
    .poll(
      async () => {
        if (exited) throw new Error(`the second server did not start:\n${log}`);
        return fetch(`${ORIGIN}/api/health`).then(
          (response) => response.status,
          () => 0,
        );
      },
      { timeout: 60_000 },
    )
    .toBe(200);
});

test.afterAll(async () => {
  const child = server;
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
});

test('the page of a fault of the server shows the reference that the server’s log holds, and nothing else of the fault', async ({
  page,
}) => {
  // The link of an invitation: the page reads the invitation from the database.
  const response = await page.goto(`${ORIGIN}/sign-up/${'A'.repeat(43)}`);
  expect(response!.status()).toBe(500);
  // Under the policy of every page; the fixture fails the test for anything the page did against it.
  expect(response!.headers()['content-security-policy']).toMatch(POLICY);

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Page not shown');
  const statement = page.getByRole('alert', { name: STATEMENT });
  await expect(statement).toBeFocused();
  // The fixed statement, then the sentence, then the reference on a line of its own: all of it, and no more.
  await expect(statement.getByRole('heading', { level: 2 })).toHaveText(STATEMENT);
  await expect(statement.locator('p')).toHaveText([QUOTE, /^Reference: [0-9]{1,10}$/]);
  const reference = /[0-9]+$/.exec((await statement.locator('p').last().textContent())!)![0];
  // The lockup (domico 0.34.0) is the tile, which has no text, the letters
  // "kdotico", and the name "Ekdotico" once in a visually hidden span.
  await expect(page.getByRole('main')).toHaveText(
    new RegExp(
      `^kdoticoEkdoticoPage not shown${STATEMENT.replaceAll('.', '\\.')}${QUOTE.replace('.', '\\.')}Reference: ${reference}$`,
    ),
  );

  // The reference is the one the server printed with the error, and the
  // application's own line of the fault stands beside it (src/app/page-fault.ts).
  await expect.poll(() => log).toContain(`digest: '${reference}'`);
  expect(log).toMatch(/^page: request failed \([A-Za-z]+( [A-Za-z0-9]{1,16})?\)$/m);
  // NFR-SE-19: the log holds nothing of the address that was asked for.
  expect(log).not.toContain('A'.repeat(43));

  // Text to select and quote, and no link or control.
  await expect(page.getByRole('main').getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button')).toHaveCount(0);
  const selected = await statement
    .locator('p')
    .last()
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return { text: selection.toString(), select: getComputedStyle(element).userSelect };
    });
  expect(selected).toEqual({ text: `Reference: ${reference}`, select: 'auto' });

  // Nothing of the error reaches the browser but the reference: not its
  // message, not its class or code, not a line of its stack. In what is shown
  // and in what was sent.
  for (const sent of [await page.content(), await response!.text()]) {
    expect(sent).not.toMatch(/page: fault|request failed|Prisma|P1001|ECONNREFUSED|nowhere|\.next\/server/);
  }

  // The same fault has the same reference: it names the place of a fault, not the one time.
  await page.reload();
  await expect(statement.locator('p').last()).toHaveText(`Reference: ${reference}`);
});
