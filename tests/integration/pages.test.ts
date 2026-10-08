// What the pages read on the server, called as the layout and the pages call
// it, against a provisioned database: the backstop of FR-AU-09 as it is wired,
// and the fault of a page (NFR-SE-06 A10, NFR-SE-19), which is one line that
// holds nothing of a row and an error that holds nothing at all.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, prepare, signIn } from './identity.ts';

// `headers` of Next.js exists only inside a request of the framework. Here it
// answers with what the test says the browser sent.
const browser = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => browser.headers }));

const database = prepare('pages');
const { auth, db, valkey } = await load();
const { currentAccount } = await import('../../src/app/(app)/account.ts');
const { default: SignIn } = await import('../../src/app/(auth)/sign-in/page.tsx');
const { default: SignUpPage } = await import('../../src/app/(auth)/sign-up/[token]/page.tsx');

let people = 0;
/** A signed-in account without its workspace, as only a fault could leave one. */
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  browser.headers = new Headers({ cookie: cookiesOf(await signIn(auth, email)) });
  return id;
}

/** What a page threw, and what it printed. */
async function faultOf(page: () => Promise<unknown>) {
  const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
  const thrown = await page().then(
    () => undefined,
    (error: unknown) => error as Error,
  );
  return { thrown, lines: printed.mock.calls.map((call) => call.join(' ')) };
}

function expectPageFault(thrown: Error | undefined) {
  expect(thrown).toBeInstanceOf(Error);
  // What Next.js logs of it: no message of the database, no cause, no code.
  expect(thrown!.message).toBe('page: fault');
  expect(thrown!.cause).toBeUndefined();
  expect(Object.keys(thrown!)).toEqual([]);
}

afterEach(() => {
  vi.restoreAllMocks();
  browser.headers = new Headers();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the backstop of FR-AU-09, as the signed-in layout calls it', () => {
  it('gives an account without a personal workspace one when it opens a page, and one only', async () => {
    const userId = await person();
    expect(await db().workspace.count({ where: { ownerId: userId } })).toBe(0);
    expect(await currentAccount()).toMatchObject({ userId, noticeDue: true });
    expect(await db().workspace.count({ where: { ownerId: userId } })).toBe(1);
    await currentAccount();
    expect(await db().workspace.count({ where: { ownerId: userId } })).toBe(1);
  });

  it('sends a browser without a session to the sign-in page, which is no fault', async () => {
    const { thrown, lines } = await faultOf(() => currentAccount());
    expect((thrown as Error & { digest?: string }).digest).toMatch(/^NEXT_REDIRECT;.*\/sign-in;/);
    expect(lines).toEqual([]);
  });
});

describe('a page that cannot read what it needs (NFR-SE-06 A10, NFR-SE-19)', () => {
  it('fails with one line and an error that holds nothing: the workspace', async () => {
    await person();
    database.sql('ALTER TABLE "Workspace" RENAME TO "WorkspaceAway"');
    let outcome: Awaited<ReturnType<typeof faultOf>>;
    try {
      outcome = await faultOf(() => currentAccount());
    } finally {
      database.sql('ALTER TABLE "WorkspaceAway" RENAME TO "Workspace"');
    }
    expectPageFault(outcome.thrown);
    expect(outcome.lines).toEqual(['page: request failed (PrismaClientKnownRequestError P2021)']);
  });

  it('fails so where the notice cannot be read', async () => {
    await person();
    vi.spyOn(db().user, 'findUnique').mockRejectedValue(
      Object.assign(new Error('the row of person@example.com'), { code: 'P1001' }),
    );
    const { thrown, lines } = await faultOf(() => currentAccount());
    expectPageFault(thrown);
    expect(lines).toEqual(['page: request failed (Error P1001)']);
  });

  it.each([
    ['a signed-in page', () => currentAccount()],
    ['the sign-in page', () => SignIn({ searchParams: Promise.resolve({}) })],
  ])('fails so where the session cannot be validated: %s', async (_, page) => {
    await person();
    vi.spyOn(auth().api, 'getSession').mockRejectedValue(
      Object.assign(new Error('the session of person@example.com'), { code: 'P1001' }),
    );
    const { thrown, lines } = await faultOf(page);
    expectPageFault(thrown);
    expect(lines).toEqual(['page: request failed (Error P1001)']);
  });

  it('fails so where the invitation cannot be read, and never as an invitation that is not open', async () => {
    database.sql('ALTER TABLE "AdmissionInvitation" RENAME TO "AdmissionInvitationAway"');
    let outcome: Awaited<ReturnType<typeof faultOf>>;
    try {
      outcome = await faultOf(() => SignUpPage({ params: Promise.resolve({ token: 'A'.repeat(43) }) }));
    } finally {
      database.sql('ALTER TABLE "AdmissionInvitationAway" RENAME TO "AdmissionInvitation"');
    }
    expectPageFault(outcome.thrown);
    expect(outcome.lines).toEqual(['page: request failed (PrismaClientKnownRequestError P2021)']);
  });
});
