// The Content-Security-Policy and the headers beside it (src/lib/csp.ts; the
// owner's decision of 9 October 2026), on the responses of the application as
// a deployment serves it: every page and every route of the repository, with
// and without a session, and the answers that are neither. And that the
// policy bites: what it refuses does not run.
import { randomUUID } from 'node:crypto';
import { globSync, readFileSync } from 'node:fs';
import type { APIResponse } from '@playwright/test';
import { newPerson, signUp } from './account.ts';
import { expect, test } from './fixtures.ts';
import { APP_ORIGIN } from './origin.ts';

// The fixed texts, written out here and not taken from the code under test.
const NOTHING = "default-src 'none'; frame-ancestors 'none'";
// A production build on localhost: without `upgrade-insecure-requests`, and nothing else differs.
const PAGE =
  /^default-src 'self'; script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'; style-src 'self' 'nonce-\1'; style-src-attr 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'$/;

const TOKEN = 'A'.repeat(43);
/** The address of a file of `src/app`, with a value for each of its parameters. */
const address = (file: string) =>
  '/' +
  file
    .replace(/^src\/app\//, '')
    .replace(/(^|\/)(page|route)\.tsx?$/, '')
    .split('/')
    .filter((part) => !/^\(.*\)$/.test(part))
    .map((part) =>
      part === '[token]'
        ? TOKEN
        : part === '[id]'
          ? randomUUID()
          : part === '[...rest]'
            ? 'no/such/page'
            : part === '[...all]'
              ? 'get-session'
              : part,
    )
    .join('/');

const pages = globSync('src/app/**/page.tsx').map(address);
const routes = globSync('src/app/**/route.ts').map(address);
// What is neither: an address without a page, one without a route, a file of
// the build that is not there, the image optimiser, which no path admits, and
// the endpoints of the identity handler that `[...all]` above does not name:
// one without a session, and two of an account.
const others = [
  '/no-such-page',
  '/api/no-such-route',
  '/_next/static/no-such-file.js',
  '/_next/image?url=%2Fx&w=64&q=75',
  '/api/auth/sign-in/link',
  '/api/auth/verify-email',
  '/api/auth/change-email',
  '/collab/health',
  '/favicon.ico',
  '/robots.txt',
];

/**
 * What every response owes, whatever it is. Returns the nonce of a page's
 * policy, or null where the response is no page and admits nothing.
 */
async function owed(response: APIResponse, what: string, path = ''): Promise<string | null> {
  const headers = response.headers();
  expect(headers['x-content-type-options'], what).toBe('nosniff');
  expect(headers['x-frame-options'], what).toBe('DENY');
  expect(headers['referrer-policy'], what).toMatch(/^(no-referrer|strict-origin-when-cross-origin)$/);
  expect(headers, what).not.toHaveProperty('content-security-policy-report-only');
  const policy = headers['content-security-policy'];
  expect(policy, what).toBeDefined();
  // One header, and not two that a browser would have to reconcile.
  expect(
    response.headersArray().filter(({ name }) => name.toLowerCase() === 'content-security-policy'),
    what,
  ).toHaveLength(1);
  // Under the prefix of the routes and that of the build nothing
  // is a page: where Next.js answers one of them with its page of an address
  // that is none, that page admits nothing either, and runs nothing.
  const html = (headers['content-type'] ?? '').startsWith('text/html') && !/^\/(api|_next)(\/|$)/.test(path);
  if (!html) {
    expect(policy, what).toBe(NOTHING);
    return null;
  }
  // A page: the policy with a nonce, and the nonce on every script the page holds.
  expect(policy, what).toMatch(PAGE);
  const nonce = PAGE.exec(policy!)![1]!;
  const scripts = (await response.text()).match(/<script\b[^>]*>/g) ?? [];
  expect(scripts.length, what).toBeGreaterThan(0);
  for (const script of scripts) expect(script, what).toContain(`nonce="${nonce}"`);
  return nonce;
}

test('every page, every route and every other answer carries the policy and the headers beside it, without a session', async ({
  request,
}) => {
  expect(pages.length).toBeGreaterThan(5);
  expect(routes.length).toBeGreaterThan(5);
  const nonces: string[] = [];
  for (const path of [...pages, ...routes, ...others]) {
    for (const method of ['GET', 'POST', 'DELETE', 'OPTIONS']) {
      const response = await request.fetch(path, { method, maxRedirects: 0 });
      const nonce = await owed(response, `${method} ${path} (${response.status()})`, path);
      if (nonce) nonces.push(nonce);
    }
  }
  // The pages a person without a session opens were answered as pages, each with a nonce of its own.
  expect(nonces.length).toBeGreaterThanOrEqual(4);
  expect(new Set(nonces).size).toBe(nonces.length);

  // The page of a token keeps its stricter word (next.config.ts, `TOKEN_PAGES`).
  // Each of them is a page of the repository, so it was asked for above; and
  // the word is sent once, not beside the weaker one of every response.
  const tokenPages = pages.filter((path) => path.endsWith(`/${TOKEN}`)).sort();
  expect(tokenPages).toEqual(
    [
      `/confirm-address/${TOKEN}`,
      `/reset-password/${TOKEN}`,
      `/sign-in/link/${TOKEN}`,
      `/sign-up/${TOKEN}`,
    ].sort(),
  );
  for (const path of tokenPages) {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(
      response
        .headersArray()
        .filter(({ name }) => name.toLowerCase() === 'referrer-policy')
        .map(({ value }) => value),
      path,
    ).toEqual(['no-referrer']);
  }
  expect((await request.get('/sign-in')).headers()['referrer-policy']).toBe(
    'strict-origin-when-cross-origin',
  );
});

test('the same with a session: pages, the page of an address that is none, and the refusals of an API route', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signUp(page, newPerson());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  const request = page.request;

  const statuses = new Map<string, number>();
  const nonces: string[] = [];
  for (const path of [...pages, ...routes, ...others]) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await request.fetch(path, { method, maxRedirects: 0 });
      statuses.set(`${method} ${path}`, response.status());
      const nonce = await owed(response, `${method} ${path} (${response.status()})`, path);
      if (nonce) nonces.push(nonce);
    }
  }
  // What was asked for was answered as it should be, so the headers above were those of each kind of answer.
  expect(statuses.get('GET /')).toBe(200);
  expect(statuses.get('GET /settings')).toBe(200);
  expect(statuses.get('GET /no-such-page')).toBe(404);
  expect(statuses.get('GET /no/such/page')).toBe(404);
  // A 403: a request that changes state without the application's own origin.
  expect(statuses.get('POST /api/documents')).toBe(403);
  expect(new Set(nonces).size).toBe(nonces.length);
  expect(nonces.length).toBeGreaterThanOrEqual(6);

  // A 401 and a 429 of an API route. The limit is 120 requests a minute for each user (NFR-SE-07).
  expect((await request.get('/api/documents')).status()).toBe(200);
  let limited: APIResponse | undefined;
  for (let asked = 0; asked < 200 && !limited; asked += 1) {
    const response = await request.get('/api/documents');
    if (response.status() === 429) limited = response;
  }
  expect(limited, 'a 429').toBeDefined();
  expect(await owed(limited!, 'the 429 of an API route')).toBeNull();
});

test('a response that did not pass the proxy carries the policy that admits nothing', async ({ request }) => {
  // Next.js does not run the proxy for a request that carries the identifier
  // of the build in this header (docs/operations/deployment.md, item 4).
  const { preview } = JSON.parse(readFileSync('.next/prerender-manifest.json', 'utf8')) as {
    preview: { previewModeId: string };
  };
  const skipping = { 'x-prerender-revalidate': preview.previewModeId };
  for (const path of ['/sign-in', '/', '/settings', `/sign-up/${TOKEN}`, '/api/documents', '/api/health']) {
    const response = await request.get(path, { headers: skipping, maxRedirects: 0 });
    const what = `${path} past the proxy (${response.status()})`;
    const headers = response.headers();
    expect(headers['content-security-policy'], what).toBe(NOTHING);
    expect(headers['x-content-type-options'], what).toBe('nosniff');
    expect(headers['x-frame-options'], what).toBe('DENY');
  }
  // The answers an endpoint makes itself, where the proxy did not refuse
  // first (src/lib/auth/route-answers.ts, `refusedOrigin`): a 403 for a
  // request without the application's origin, a 409 for a link that is none,
  // and a 401 without a session. And the 409 again by way of the proxy.
  const own = { ...skipping, origin: APP_ORIGIN };
  const made: [string, Record<string, string>, number][] = [
    ['/api/auth/sign-in/link', skipping, 403],
    ['/api/auth/sign-in/link', own, 409],
    ['/api/auth/verify-email', skipping, 403],
    ['/api/auth/verify-email', own, 401],
    ['/api/sign-up', skipping, 403],
    ['/api/auth/sign-in/link', { origin: APP_ORIGIN }, 409],
  ];
  for (const [path, headers, status] of made) {
    const response = await request.post(path, { headers, data: { token: TOKEN } });
    const what = `POST ${path} (${response.status()})`;
    expect(response.status(), what).toBe(status);
    expect(await owed(response, what, path)).toBeNull();
  }
  // The proxy did not run: the sign-in page was answered, and as no page of the proxy's is.
  expect((await request.get('/sign-in', { headers: skipping })).status()).toBe(200);
  expect((await request.get('/sign-in')).headers()['content-security-policy']).toMatch(PAGE);
  // A nonce the client sends is not taken for the page's, with or without the proxy.
  for (const headers of [{}, skipping]) {
    const response = await request.get('/sign-in', {
      headers: { ...headers, 'x-nonce': 'chosen', 'content-security-policy': "script-src 'nonce-chosen'" },
    });
    expect(response.headers()['content-security-policy']).not.toContain('chosen');
  }
});

test('a file of the build is served with the headers, and no page can be framed', async ({
  page,
  request,
  violations,
}) => {
  // The browser writes of the frame it refused.
  violations.expected = true;
  await page.goto('/sign-in');
  const files = await page.evaluate(() =>
    [...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map(
      (each) => (each as HTMLScriptElement).src || (each as HTMLLinkElement).href,
    ),
  );
  expect(files.length).toBeGreaterThan(1);
  for (const file of files) {
    expect(new URL(file).origin).toBe(APP_ORIGIN);
    const response = await request.get(file);
    expect(response.status(), file).toBe(200);
    expect(await owed(response, file, new URL(file).pathname)).toBeNull();
  }

  // Framing: refused by both headers, so the frame holds nothing of the page.
  await page.setContent(`<iframe src="${APP_ORIGIN}/sign-in" width="400" height="300"></iframe>`);
  const frame = page.frames()[1]!;
  await page.waitForTimeout(1500);
  expect(
    await frame
      .locator('h1')
      .count()
      .catch(() => 0),
  ).toBe(0);
  expect(frame.url()).not.toBe(`${APP_ORIGIN}/sign-in`);
});

test('the appearance a reader chose is restored before the page is drawn, in light and in dark', async ({
  page,
}) => {
  // The design package's script in the head, which runs by the nonce of the request.
  await page.goto('/sign-in');
  await expect(page.locator('html')).not.toHaveAttribute('data-mode', /./);
  for (const mode of ['dark', 'light']) {
    await page.evaluate((chosen) => localStorage.setItem('ekd-mode', chosen), mode);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
});

test('the policy bites: an inline script, a handler, a script and a request of another origin do not run', async ({
  page,
  violations,
}) => {
  violations.expected = true;
  // Never asked for, if the policy holds; and if it does not, answered here and not by the internet.
  const reached: string[] = [];
  await page.route('https://example.com/**', (route) => {
    reached.push(route.request().url());
    return route.fulfill({ contentType: 'text/javascript', body: 'window.__ran = "remote";' });
  });
  await signUp(page, newPerson());
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  expect(violations.seen).toEqual([]);

  const found = await page.evaluate(async () => {
    const outcome: Record<string, unknown> = {};
    // Markup as an injection would leave it: parsed, and put into the page.
    const markup = (html: string) =>
      document.body.appendChild(document.createRange().createContextualFragment(html));
    markup('<script>window.__ran = "inline";</script>');
    markup('<script src="https://example.com/x.js"></script>');
    markup('<img src="/no-such-image" onerror="window.__ran = \'handler\'">');
    markup('<a id="scripted" href="javascript:window.__ran = \'address\'">x</a>');
    document.querySelector<HTMLAnchorElement>('#scripted')!.click();
    markup('<style>body { display: none !important }</style>');
    markup('<img src="https://example.com/pixel.png">');
    // A script that is made with no nonce and holds its own text.
    const made = document.createElement('script');
    made.textContent = 'window.__ran = "made";';
    document.body.appendChild(made);
    // In a task of the page's own: the evaluation of this function is the test's, which the browser lets evaluate text.
    outcome.evaluated = await new Promise((resolve) =>
      setTimeout(() => {
        try {
          resolve(new Function('return 1')());
        } catch (error) {
          resolve(String(error).slice(0, 40));
        }
      }),
    );
    outcome.fetched = await fetch('https://example.com/').then(
      () => 'answered',
      () => 'refused',
    );
    outcome.socket = await new Promise((resolve) => {
      try {
        const socket = new WebSocket('wss://example.com/collab');
        socket.onerror = () => resolve('refused');
        socket.onopen = () => resolve('opened');
      } catch {
        resolve('refused');
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    outcome.ran = (window as unknown as { __ran?: string }).__ran ?? null;
    outcome.shown = getComputedStyle(document.body).display !== 'none';
    return outcome;
  });
  expect(found.ran).toBeNull();
  // And markup that the parser itself reads, as markup injected into a page is read.
  const written = await page.evaluate(async () => {
    const refused: string[] = [];
    document.open();
    document.addEventListener('securitypolicyviolation', (event) => {
      refused.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
    const close = '</' + 'script>';
    document.write(
      `<p>written</p><script src="https://example.com/x.js">${close}<script>window.__ran = "written";${close}`,
    );
    document.close();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { refused: refused.sort(), ran: (window as unknown as { __ran?: string }).__ran ?? null };
  });
  expect(written.ran).toBeNull();
  expect(written.refused).toEqual(['script-src-elem https://example.com/x.js', 'script-src-elem inline']);
  expect(found.shown).toBe(true);
  expect(found.evaluated).toMatch(/EvalError/);
  expect(found.fetched).toBe('refused');
  expect(found.socket).toBe('refused');
  expect(reached).toEqual([]);
  // Each was refused by the policy, and reported as such.
  const seen = [...new Set(violations.seen.filter((line) => !line.startsWith('console:')))].sort();
  expect(seen).toEqual(
    [
      'connect-src https://example.com/',
      'connect-src wss://example.com/collab',
      'img-src https://example.com/pixel.png',
      'script-src-attr inline',
      'script-src-elem https://example.com/x.js',
      'script-src-elem inline',
      'script-src eval',
      'style-src-elem inline',
    ].sort(),
  );
});
