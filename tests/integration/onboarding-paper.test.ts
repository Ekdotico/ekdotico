// The Onboarding paper, given to an account once (src/lib/documents/onboarding-paper.ts; the owner's
// decisions of 22 November 2026), against a provisioned database: made once, once under two requests at
// once, not for an account in deletion, never at the cost of anything else when it fails, and not made
// again where the person has deleted it.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('onboarding-paper', { TRUSTED_PROXY_COUNT: '1' });
const { auth, db, valkey } = await load();
const { ensureOnboardingPaper, ONBOARDING_TITLE, onboardingState } =
  await import('../../src/lib/documents/onboarding-paper.ts');
const { ownedDocuments } = await import('../../src/lib/account/deletion.ts');
const collection = await import('../../src/app/api/documents/route.ts');

let people = 0;
/** An account that has not been given its paper. */
async function person() {
  const email = `reader${++people}@example.com`;
  return { id: await createAccount(auth, email, true, true), email };
}
const documentsOf = (id: string) =>
  db().document.findMany({
    where: { ownerId: id },
    select: { id: true, title: true, recording: true, deletedAt: true },
  });
const marker = async (id: string) =>
  (await db().user.findUniqueOrThrow({ where: { id }, select: { onboardingPaperSeededAt: true } }))
    .onboardingPaperSeededAt;

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the Onboarding paper', () => {
  it('is made once, as an ordinary document of the account, with the state of the paper', async () => {
    const { id } = await person();
    expect(await marker(id)).toBeNull();
    await ensureOnboardingPaper(id);
    await ensureOnboardingPaper(id);
    const documents = await documentsOf(id);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ title: ONBOARDING_TITLE, recording: 'UNRECORDED', deletedAt: null });
    const stored = await db().document.findUniqueOrThrow({
      where: { id: documents[0]!.id },
      select: { yjsState: true, workspace: { select: { ownerId: true, type: true } }, permissionSet: true },
    });
    expect(Buffer.from(stored.yjsState!).equals(Buffer.from(onboardingState()))).toBe(true);
    expect(stored.workspace).toEqual({ ownerId: id, type: 'PERSONAL' });
    expect(await marker(id)).toBeInstanceOf(Date);
  });

  it('is made once where two requests ask at once', async () => {
    const { id } = await person();
    await Promise.all(Array.from({ length: 8 }, () => ensureOnboardingPaper(id)));
    expect(await documentsOf(id)).toHaveLength(1);
  });

  it('is not made for an account in deletion, and leaves no claim', async () => {
    const { id } = await person();
    await db().accountDeletion.create({ data: { userId: id } });
    await ensureOnboardingPaper(id);
    expect(await documentsOf(id)).toHaveLength(0);
    expect(await marker(id)).toBeNull();
  });

  it('counts as one document of the account, as any does (FR-AU-58)', async () => {
    const { id } = await person();
    await ensureOnboardingPaper(id);
    expect((await ownedDocuments(id)).owned).toBe(1);
  });

  it('is not made again where the person has deleted it, or deleted it permanently', async () => {
    const { id } = await person();
    await ensureOnboardingPaper(id);
    const [paper] = await documentsOf(id);
    await db().document.update({ where: { id: paper!.id }, data: { deletedAt: new Date() } });
    await ensureOnboardingPaper(id);
    expect(await documentsOf(id)).toHaveLength(1);
    await db().document.delete({ where: { id: paper!.id } });
    await ensureOnboardingPaper(id);
    expect(await documentsOf(id)).toHaveLength(0);
  });

  it('never fails the caller where the insert fails, leaves the account and the claim as they were, and is made at the next try', async () => {
    const { id } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    database.sql('ALTER TABLE "ekdotico"."Document" RENAME COLUMN "yjsState" TO "yjsStateAway"');
    try {
      await expect(ensureOnboardingPaper(id)).resolves.toBeUndefined();
    } finally {
      database.sql('ALTER TABLE "ekdotico"."Document" RENAME COLUMN "yjsStateAway" TO "yjsState"');
    }
    // The class of the fault, and nothing else (NFR-SE-19).
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]![0])).toMatch(/^onboarding paper: not made \(\w+/);
    expect(await db().user.count({ where: { id } })).toBe(1);
    expect(await marker(id)).toBeNull();
    expect(await documentsOf(id)).toHaveLength(0);
    await ensureOnboardingPaper(id);
    expect(await documentsOf(id)).toHaveLength(1);
  });

  it('is in the list the route answers, for an account that was not given it, and in none of an account that was', async () => {
    const { id, email } = await person();
    const cookie = cookiesOf(await signIn(auth, email));
    const list = async () =>
      (await (await collection.GET(new Request(`${ORIGIN}/api/documents`, { headers: { cookie } }))).json())
        .documents as { id: string; title: string }[];
    expect((await list()).map(({ title }) => title)).toEqual([ONBOARDING_TITLE]);
    expect(await list()).toHaveLength(1);
    expect(await documentsOf(id)).toHaveLength(1);

    const other = `reader${++people}@example.com`;
    await createAccount(auth, other); // marked, as every account of the other tests is
    const otherCookie = cookiesOf(await signIn(auth, other));
    const answer = await collection.GET(
      new Request(`${ORIGIN}/api/documents`, { headers: { cookie: otherCookie } }),
    );
    expect((await answer.json()).documents).toEqual([]);
  });
});
