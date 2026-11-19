// The page for a visitor who is not signed in (FR-AU-93; register D327 to D330):
// at the root, with no redirect, no cookie, the approved text, and the links;
// and a person signed in reaches their documents there as before. The
// contact address is unset in the test environment (D329), so the line is the
// owner's "list-only" one.
import { spawn } from 'node:child_process';
import { expect, test } from './fixtures.ts';
import { APP_PORT, AUTH_SECRET } from './origin.ts';
import { newPerson, signUp } from './account.ts';

test('a visitor at the root gets the page, at the same address, with no cookie', async ({
  page,
  request,
}) => {
  const response = await request.get('/', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headersArray().filter(({ name }) => name.toLowerCase() === 'set-cookie')).toEqual([]);
  expect((await request.head('/', { maxRedirects: 0 })).status()).toBe(200);

  await page.goto('/');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ekdotico is in Closed α');
  await expect(
    page.getByText(
      'Ekdotico is being tested by a small group, and accounts are by invitation. Each invitation is sent by a person on the team.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('To ask for one, add your email address to the list.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('write to')).toHaveCount(0);
  await expect(page.getByText('Already invited?')).toBeVisible();

  const add = page.getByRole('link', { name: 'Add your email address' });
  await expect(add).toHaveAttribute('href', 'https://alpha.ekdoti.co');
  await expect(add).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  expect(await page.context().cookies()).toEqual([]);

  await page.getByRole('link', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/sign-in');
});

test('the internal page answers 404 when it is asked for by name', async ({ request }) => {
  expect((await request.get('/visitors-page', { maxRedirects: 0 })).status()).toBe(404);
});

test('a person signed in reaches their documents at the root, not the page of visitors', async ({ page }) => {
  await signUp(page, newPerson());
  await page.getByRole('button', { name: 'Continue' }).click();
  // Wait for the page Continue leads to: a navigation still under way aborts the next one.
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
  await expect(page.getByText('Ekdotico is in Closed α')).toHaveCount(0);
  // The mark of a visitor is the proxy's: one a client sends is taken off (src/lib/visitors.ts).
  const forged = await page.request.get('/', { headers: { 'x-ekdotico-visitor': '1' } });
  expect(forged.status()).toBe(200);
  expect(await forged.text()).not.toContain('Ekdotico is in Closed α');
});

// The fault of 18 November 2026: a deployment starts the application with
// `--hostname 127.0.0.1` behind a reverse proxy that says the request came
// over TLS (docs/operations/deployment.md), and there Next.js took the
// proxy's rewrite of `/` for one to another origin and answered 500
// (src/lib/visitors.ts). The server of this run is started without a host
// name, which hides it, so this starts the same build a second time as a
// deployment does.
test('a visitor at the root gets the page from a process started as a deployment starts it', async () => {
  test.setTimeout(90_000);
  const port = String(Number(APP_PORT) + 7);
  const origin = `http://127.0.0.1:${port}`;
  const server = spawn(
    'node',
    ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '-p', port],
    {
      env: {
        ...process.env,
        FOUNDING_TEAM_EMAILS: process.env.E2E_FOUNDER,
        APP_ORIGIN: origin,
        DATABASE_URL: process.env.E2E_DATABASE_URL,
        VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
        AUTH_SECRET,
        ADMISSION_SECRET: process.env.E2E_ADMISSION_SECRET,
        EMAIL_TRANSPORT: 'sink',
        EMAIL_SINK_DIRECTORY: process.env.E2E_EMAIL_SINK,
        RATE_LIMIT_SESSIONLESS_PER_ADDRESS: '100000/60',
      },
      stdio: 'ignore',
    },
  );
  try {
    await expect
      .poll(
        () =>
          fetch(`${origin}/api/health`).then(
            ({ status }) => status,
            () => 0,
          ),
        { timeout: 60_000 },
      )
      .toBe(200);
    const forwarded = { 'x-forwarded-proto': 'https' };
    const response = await fetch(`${origin}/`, { redirect: 'manual', headers: forwarded });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toContain('Ekdotico is in Closed α');
    expect(
      (await fetch(`${origin}/`, { method: 'HEAD', redirect: 'manual', headers: forwarded })).status,
    ).toBe(200);
    expect((await fetch(`${origin}/visitors-page`, { redirect: 'manual', headers: forwarded })).status).toBe(
      404,
    );
  } finally {
    server.kill();
  }
});
