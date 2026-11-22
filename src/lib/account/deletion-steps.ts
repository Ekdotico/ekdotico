// The steps of an account deletion (FR-AU-58, NFR-RE-15, NFR-DP-06, NFR-DP-09),
// carried out in order after the user has confirmed (./deletion.ts), "repeating
// a step that fails until it succeeds, so that a confirmed deletion completes
// without the user". On a timer of the application, and once more at the
// confirmation, after the response (src/app/api/account/route.ts). Not a queue
// job.
//
//   (a) the connections are closed: the confirmation itself (./deletion.ts).
//   (b) Istorico pseudonymises the user, where it holds anything.
//   (c) the feedback intake pseudonymises the feedback, behind a switch that is
//       off (./feedback-step.ts).
//   (d) every session ends and the credentials are deleted.
//   (e) the personal data of the user's row is cleared, and (f) the roles end and
//       the invitations and offers are settled: one transaction (`rows`), because
//       (f) finds the invitations addressed to the account by the address that (e)
//       clears.
//
// THE CLAIM (NFR-RE-15, as the permanent deletion of a document has it): of two
// instances that reach a deletion together, one conditional write lets one take
// it, and the other leaves it alone. The time written is also the mark of the
// claim: every step's write is made only while the row still holds it, so a
// claim taken over (it is an hour old: its process stopped) cannot be written
// under by the run that lost it. A run releases its claim whatever happened, so
// that a step that failed is repeated at the next run and not an hour after.
//
// NO STEP CAN BE SKIPPED. A step's time is set in the transaction that does its
// work, with its entry in the security log (NFR-SE-19), and the database refuses
// a time whose earlier step has none (the checks of the migration). A crash
// between the work and its record repeats the step, which is idempotent; a
// crash after leaves it done. A step is never recorded without its work.
//
// NFR-SE-19: nothing here logs a name, an address or a token. A line names the
// deletion (an identifier of the application's own), the step and the class of
// the fault.
import type { Prisma } from '../../generated/prisma/client.ts';
import { publishCollabEvent } from '../collab/events.ts';
import { db } from '../db.ts';
import { faultOf } from '../fault.ts';
import { clearAdmissionAddressOf } from '../admission/invitations.ts';
import { pendingChange } from '../auth/address-links.ts';
import { forgetFailedSignIns } from '../auth/sign-in.ts';
import { declineOffersTo } from '../documents/ownership.ts';
import { endInvitationsOfAccount } from '../documents/sharing.ts';
import { istorico, type IstoricoPort } from '../istorico/index.ts';
import { securityLogIn, securityLogManyIn } from '../security-log.ts';
import { DETACH_AGAIN_MS, feedbackAgain, feedbackStep, type FeedbackOutcome } from './feedback-step.ts';

type Tx = Prisma.TransactionClient;

// A claim this old was not finished: its process stopped between the claim and the end. The timer
// runs each hour, and each statement is bounded in seconds (src/lib/db.ts).
export const CLAIM_STALE_MS = 60 * 60 * 1000;

/** What a run may be given in place of the real ones: the port, and the pieces of step (c). */
export interface Dependencies {
  port?: IstoricoPort;
  feedback?: Parameters<typeof feedbackStep>[1];
}

/** The claim is no longer this run's: another run took it over. Nothing is written under it, and nothing is said. */
class ClaimLost extends Error {
  name = 'AccountDeletionClaimLost';
}

interface Held {
  id: string;
  userId: string;
  claim: Date;
}

/**
 * First in the transaction of every step: finds that the claim is still this run's, and holds the
 * row of the deletion to the commit, by writing it with its own value.
 */
async function holdClaim(tx: Tx, { id, claim }: Held): Promise<void> {
  const { count } = await tx.accountDeletion.updateMany({
    where: { id, claimedAt: claim, completedAt: null },
    data: { claimedAt: claim },
  });
  if (count !== 1) throw new ClaimLost();
}

type StepTime =
  | 'istoricoDoneAt'
  | 'feedbackDoneAt'
  | 'feedbackSkippedAt'
  | 'credentialsDoneAt'
  | 'rowsDoneAt'
  | 'feedbackAgainDoneAt';

/**
 * Last in the transaction of a step: the step's time, only where it has none and the claim is this
 * run's. The step before it is the database's to ask (the checks of the migration), so a step
 * written out of order is a fault of the transaction and not a state of the row.
 */
async function record(tx: Tx, { id, claim }: Held, column: StepTime, at: Date): Promise<void> {
  const { count } = await tx.accountDeletion.updateMany({
    where: { id, claimedAt: claim, completedAt: null, [column]: null },
    data: { [column]: at },
  });
  if (count !== 1) throw new ClaimLost();
}

// ── (b) Istorico ────────────────────────────────────────────────────────────

/**
 * FR-AU-58 (b), NFR-DP-09 (a): "Istorico pseudonymises the user in what it holds, through the
 * erasure call of the integration contract, and Ekdotico waits for its outcome. Where the adapter
 * does not report the erasure capability, as with the no-op adapter, Istorico holds nothing and no
 * call is made." Decided from the capability and never from the adapter's name (IC-14).
 *
 * With the capability: for each recorded document the account holds a role on, `erase` with the role
 * `contributor` (IC-29: "an account is deleted in Closed α"), under one request identifier, the
 * deletion's own, so that a repeated call is the same request (IC-11). The step is done only when
 * every outcome is `pseudonymised` or `no-record`: a hold, an error, an outcome this version does
 * not know, and an answer that leaves a document out all leave it owed, and it is repeated.
 * Not reached in α 0.1.0, where the port reports no erasure; written, and tested against an adapter
 * that does (IC-49, Q11 (b)). Which documents Istorico must be told of, for a role the account no
 * longer holds, is not settled (docs/plan/slice-22.md, S22-6).
 */
async function stepIstorico(held: Held, port: IstoricoPort, now: () => Date): Promise<void> {
  if (port.capabilities().erasure) {
    const documents = await db().documentCollaborator.findMany({
      where: { userId: held.userId, document: { recording: 'RECORDED' } },
      select: { documentId: true },
      orderBy: { documentId: 'asc' },
    });
    if (documents.length > 0) {
      const result = await port.erase({
        requestId: held.id,
        subjectUserId: held.userId,
        documents: documents.map(({ documentId }) => ({
          documentId,
          role: 'contributor' as const,
          // Every document of α 0.1.0 is in a personal workspace (FR-ED-36 "covers documents in a
          // personal workspace", as `deletePermanently` has it); the kind is read from the document's
          // workspace when an institutional one exists.
          workspaceKind: 'personal' as const,
        })),
      });
      if (!result.ok) throw new Error('Istorico did not answer the erasure call.');
      const settled = new Set(
        result.value
          .filter(({ outcome }) => outcome === 'pseudonymised' || outcome === 'no-record')
          .map(({ documentId }) => documentId),
      );
      if (!documents.every(({ documentId }) => settled.has(documentId))) {
        throw new Error('Istorico has not pseudonymised every document.');
      }
    }
  }
  await db().$transaction(async (tx) => {
    await holdClaim(tx, held);
    await record(tx, held, 'istoricoDoneAt', now());
    await securityLogIn(tx, { kind: 'account_deletion_istorico_pseudonymised', userId: held.userId });
  });
}

// ── (c) The feedback intake ─────────────────────────────────────────────────

/**
 * FR-AU-58 (c): with the switch off, no call, and the step "is recorded as skipped"; with it on, one
 * instruction, and the step is done when the intake acknowledges. Either way it is a step of the
 * deletion that is written, with its entry (NFR-SE-19: "each step").
 */
async function stepFeedback(held: Held, options: Dependencies['feedback'], now: () => Date): Promise<void> {
  const outcome: FeedbackOutcome = await feedbackStep(held.userId, options);
  await db().$transaction(async (tx) => {
    await holdClaim(tx, held);
    if (outcome === 'skipped') {
      await record(tx, held, 'feedbackSkippedAt', now());
      await securityLogIn(tx, { kind: 'account_deletion_feedback_skipped', userId: held.userId });
    } else {
      await record(tx, held, 'feedbackDoneAt', now());
      await securityLogIn(tx, { kind: 'account_deletion_feedback_pseudonymised', userId: held.userId });
    }
  });
}

// ── (d) The sessions and the credentials ────────────────────────────────────

/**
 * The rows of the identity library's single-use tokens that belong to an account: those whose value
 * is its identifier (a reset link, an open second step, the link of a lock), those whose value
 * begins with its identifier and a space (a pending change of the address, which holds the new
 * address after it: src/lib/auth/address-links.ts), and, were the library to key one by address,
 * those whose identifier is the address. "The identity library's verification rows, which are kept by
 * address, are deleted in step (d)" (FR-AU-58 (e)).
 */
export async function deleteVerificationRowsOf(
  tx: Pick<Tx, 'verification'>,
  userId: string,
  email: string | null,
): Promise<void> {
  await tx.verification.deleteMany({
    where: {
      OR: [
        { value: userId },
        { value: { startsWith: pendingChange(userId, '') } },
        ...(email ? [{ identifier: email }] : []),
      ],
    },
  });
}

/**
 * FR-AU-58 (d): "Ekdotico ends every session of the user and deletes the user's credentials: every
 * row the identity library holds for the user in its session, credential, verification, and
 * second-factor tables is deleted, so that no one can sign in to the account again."
 *
 * In the order a reset of the password takes them (src/lib/auth/password.ts: the single-use
 * rows, the credential, the sessions), so that none waits for another in a circle, and so that a
 * sign-in that is on its way meets one of two ends: the credential is gone when it asks for it
 * again (`stillVerified`) and its session is deleted as it is, or its session was made before the
 * sessions here are deleted and is among them. The collaboration servers are told once the
 * transaction has committed, and never before.
 *
 * The key in Valkey that clears the counts of failed sign-ins for the address (`sign-in-generation`,
 * src/lib/auth/sign-in.ts) is deleted after the commit: it is a keyed digest of the address and would
 * otherwise stay (it has a lifetime of its own, but the address is to be held nowhere once the
 * account is deleted, FR-AU-58 (e)). A fault of Valkey is one line, and the key expires by itself.
 */
async function stepCredentials(held: Held, now: () => Date): Promise<void> {
  const address = await db().$transaction(async (tx) => {
    await holdClaim(tx, held);
    const user = await tx.user.findUnique({ where: { id: held.userId }, select: { email: true } });
    await deleteVerificationRowsOf(tx, held.userId, user?.email ?? null);
    await tx.account.deleteMany({ where: { userId: held.userId } });
    await tx.twoFactor.deleteMany({ where: { userId: held.userId } });
    await tx.session.deleteMany({ where: { userId: held.userId } });
    await record(tx, held, 'credentialsDoneAt', now());
    await securityLogIn(tx, { kind: 'account_deletion_credentials_deleted', userId: held.userId });
    return user?.email ?? null;
  });
  await publishCollabEvent({ kind: 'session-ended', userId: held.userId });
  if (address) {
    await forgetFailedSignIns(address).catch((error: unknown) =>
      console.error(
        `account deletion ${held.id}: counts of failed sign-ins not forgotten (${faultOf(error)})`,
      ),
    );
  }
}

// ── (e) and (f) The application's own rows ──────────────────────────────────

/**
 * FR-AU-58 (e), (f), in one transaction (docs/plan/slice-22.md, S22-4).
 *
 * (f) The rows of the documents of others are held first, in a fixed order, as every change to who
 * holds a role on a document holds its row (`lockDocument`): an offer made to the account at this
 * moment is either declined here or never made. Then "every pending offer of ownership made to the
 * user is declined (FR-ED-47)"; "the user's roles on the documents of others end, as a removal ends
 * them (FR-ED-38): each collaborator row of the user is deleted, and what the user contributed
 * stays in each document"; "every pending invitation the user sent or was sent is revoked
 * (FR-ED-37)", "the invited address is cleared from every document invitation that was addressed to
 * the user", and the pseudonym of every invitation it sent loses the sender's name.
 *
 * (e) "the name, the email address, and the avatar … are cleared, and nothing from which the person
 * could be found is put in their place. The row remains as a tombstone that keeps the internal user
 * identifier of FR-AU-04, the time of the deletion, and the acknowledgement recorded under FR-AU-56."
 * The address is also cleared from the admission invitation the account was created from. What is
 * left in the row besides is the table's own: `createdAt` and `updatedAt`, which cannot be null
 * (docs/plan/slice-22.md, S22-3). `emailVerified`, `twoFactorEnabled` and `lockedUntil` are set back
 * to what an account without an address has. The notifications of the account are kept, and shown
 * to no one (FR-ED-42): there is no session to show them to.
 *
 * Idempotent: a repetition finds the roles gone and the fields empty.
 */
async function stepRows(held: Held, now: () => Date): Promise<void> {
  await db().$transaction(async (tx) => {
    await holdClaim(tx, held);
    const at = now();
    const { userId } = held;

    // The address is read once, here, before (e) clears it: the invitations addressed to the account are
    // found by it.
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, erasedAt: true },
    });

    // The rows of every document on which the account holds a role, has a pending offer, or has a pending
    // invitation addressed to it are held, in a fixed order: each of those can be changed by a request that
    // is on its way, and every one of them holds the document's row (`lockDocument`).
    const [roles, offers, invited] = await Promise.all([
      tx.documentCollaborator.findMany({ where: { userId }, select: { documentId: true } }),
      tx.ownershipOffer.findMany({
        where: { toUserId: userId, state: 'PENDING' },
        select: { documentId: true },
      }),
      user.email
        ? tx.documentInvitation.findMany({
            where: { email: user.email, state: 'PENDING' },
            select: { documentId: true },
          })
        : [],
    ]);
    const documentIds = [
      ...new Set([...roles, ...offers, ...invited].map(({ documentId }) => documentId)),
    ].sort();
    // P-11: one statement for all of them (a query for each document passed the transaction's time with
    // some thousands of roles). `ORDER BY` fixes the order in which the rows are locked, as the sort did.
    // Same condition as `lockDocument`: a deleted document is not held.
    if (documentIds.length > 0) {
      await tx.$queryRaw`
        SELECT "id" FROM "ekdotico"."Document"
        WHERE "id" = ANY(${documentIds}::uuid[]) AND "deletedAt" IS NULL
        ORDER BY "id"
        FOR UPDATE`;
    }

    await declineOffersTo(tx, userId, at);
    // The invitations before the roles: an acceptance that was on its way has committed by now, because its
    // document is held above, and its role is among those deleted below. Were the roles deleted first, an
    // acceptance that committed between the two statements would leave the tombstone a role.
    await endInvitationsOfAccount(tx, { id: userId, email: user.email }, at);
    const ended = await tx.documentCollaborator.findMany({ where: { userId }, select: { documentId: true } });
    await tx.documentCollaborator.deleteMany({ where: { userId } });
    // NFR-SE-19: "a change to a document's collaborators" has its entry, one for each document, as a
    // removal and a leave have theirs (src/lib/documents/collaborators.ts); the one who acts is the one who goes.
    // One insert for all of them (P-11).
    await securityLogManyIn(
      tx,
      ended.map(({ documentId }) => ({ kind: 'collaborators_changed', userId, documentId })),
    );
    await clearAdmissionAddressOf(tx, { id: userId, email: user.email });
    // Again, now that the account is held: a request for a reset that began before the sessions
    // ended may have written its link since (d).
    await deleteVerificationRowsOf(tx, userId, user.email);
    await tx.user.update({
      where: { id: userId },
      data: {
        name: null,
        email: null,
        image: null,
        emailVerified: false,
        twoFactorEnabled: false,
        lockedUntil: null,
        // FR-AU-58 (e), D242: the tombstone keeps the identifier, the time of the deletion and the
        // acknowledgement, and "nothing else is kept". The time the Onboarding paper was given is none of them.
        onboardingPaperSeededAt: null,
        // The time of the deletion is the first: a step repeated after a crash does not move it.
        erasedAt: user.erasedAt ?? at,
      },
    });

    await record(tx, held, 'rowsDoneAt', at);
    // The deletion is complete with its last step. Where step (c) made its call, the last step is the second
    // call (g), which completes it (`stepFeedbackAgain`); where (c) was skipped, there is no second call and
    // this is the last. The claim goes with the completion.
    const completed = await tx.accountDeletion.updateMany({
      where: {
        id: held.id,
        claimedAt: held.claim,
        completedAt: null,
        rowsDoneAt: { not: null },
        feedbackSkippedAt: { not: null },
      },
      data: { completedAt: at, claimedAt: null },
    });
    if (completed.count === 0) {
      // Not complete: the claim must still be this run's, as it was when the step began.
      await holdClaim(tx, held);
    }
    await securityLogIn(tx, { kind: 'account_deletion_user_pseudonymised', userId });
    await securityLogIn(tx, { kind: 'account_deletion_roles_ended', userId });
  });
}

// ── (g) The second call to the feedback intake ──────────────────────────────

/**
 * Step (g), the last (fw-late-write): the intake is told again to pseudonymise the account's feedback, at least
 * 301 seconds after step (c) did, so that a submission that was in flight at (c) and stored after it is detached
 * too. It is owed only where (c) made its call; with (c) skipped the deletion was completed by (e) and (f). The
 * deletion is complete when this is done, and not before. Resolves to `'later'` where it is not yet due, which
 * leaves the deletion open for a later run and is no failure; throws where the intake did not acknowledge, and is
 * repeated like (c).
 */
async function stepFeedbackAgain(
  held: Held,
  options: Dependencies['feedback'],
  now: () => Date,
): Promise<'later' | 'nothing' | void> {
  const row = await db().accountDeletion.findUniqueOrThrow({
    where: { id: held.id },
    select: { feedbackDoneAt: true, completedAt: true },
  });
  if (row.completedAt) return 'nothing';
  if (!row.feedbackDoneAt || now().getTime() < row.feedbackDoneAt.getTime() + DETACH_AGAIN_MS) return 'later';
  await feedbackAgain(held.userId, options);
  await db().$transaction(async (tx) => {
    await holdClaim(tx, held);
    const at = now();
    await record(tx, held, 'feedbackAgainDoneAt', at);
    const completed = await tx.accountDeletion.updateMany({
      where: {
        id: held.id,
        claimedAt: held.claim,
        completedAt: null,
        rowsDoneAt: { not: null },
        feedbackAgainDoneAt: { not: null },
      },
      data: { completedAt: at, claimedAt: null },
    });
    if (completed.count !== 1) throw new ClaimLost();
    await securityLogIn(tx, { kind: 'account_deletion_feedback_repeated', userId: held.userId });
  });
}

// ── The run ─────────────────────────────────────────────────────────────────

export interface RunOutcome {
  /** Steps carried out and recorded by this call. */
  steps: number;
  /** Deletions this call completed. */
  completed: number;
  /** Deletions it had to leave for the next run, a step of which failed. */
  failed: number;
  /** Deletions still open a month after their confirmation (NFR-DP-06). */
  overdue: number;
  /** Deletions stuck at step (c) for 24 hours (fw-detach-wait): the alarm. Counts only; no account is named. */
  stuckAtFeedback: number;
}

/** fw-detach-wait: an alarm is raised when a deletion has been stuck at a call to the intake this long. */
export const FEEDBACK_ALARM_MS = 24 * 60 * 60 * 1000;

/**
 * Whether an open deletion is waiting on a call to the feedback intake: at (c), the steps before it done and it not
 * done or skipped; or at (g), (c) done, the application's rows done, and the second call not made.
 */
export function stuckAtDetach(
  row: {
    istoricoDoneAt: Date | null;
    feedbackDoneAt: Date | null;
    feedbackSkippedAt: Date | null;
    rowsDoneAt: Date | null;
    feedbackAgainDoneAt: Date | null;
  },
  now: Date,
): boolean {
  const atFirst =
    row.istoricoDoneAt !== null && row.feedbackDoneAt === null && row.feedbackSkippedAt === null;
  // The second call is owed from the day (c) was done: a day after it, and not a day after the confirmation,
  // so that a deletion whose (c) only just succeeded is not reported while it waits for its 360 seconds.
  const atSecond =
    row.feedbackDoneAt !== null &&
    row.rowsDoneAt !== null &&
    row.feedbackAgainDoneAt === null &&
    row.feedbackDoneAt.getTime() + FEEDBACK_ALARM_MS <= now.getTime();
  return atFirst || atSecond;
}

/** One calendar month after a time: the limit of NFR-DP-06 ("within one month of receipt"). */
export function oneMonthAfter(time: Date): Date {
  const later = new Date(time);
  later.setUTCMonth(later.getUTCMonth() + 1);
  return later;
}

/**
 * Carries out the steps still owed of one deletion, in order, under a claim. Resolves to the steps
 * recorded, whether the deletion was completed, and whether a step failed (it has said which, and
 * the steps before it were recorded). Rejects only for a fault that is not a step's.
 */
async function carryOut(
  id: string,
  claim: Date,
  dependencies: Dependencies,
): Promise<{ steps: number; completed: boolean; failed: boolean }> {
  const claimed = await db().accountDeletion.updateMany({
    where: {
      id,
      completedAt: null,
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(claim.getTime() - CLAIM_STALE_MS) } }],
    },
    data: { claimedAt: claim },
  });
  if (claimed.count !== 1) return { steps: 0, completed: false, failed: false };

  // The time of each record is read when the step is recorded: a run that works for long must not
  // write the time at which it began.
  const began = Date.now();
  const now = () => new Date(claim.getTime() + (Date.now() - began));
  const port = dependencies.port ?? istorico();
  let steps = 0;
  try {
    const row = await db().accountDeletion.findUniqueOrThrow({ where: { id } });
    const held: Held = { id, userId: row.userId, claim };
    const plan: [name: string, done: boolean, run: () => Promise<'later' | 'nothing' | void>][] = [
      ['istorico', row.istoricoDoneAt !== null, () => stepIstorico(held, port, now)],
      [
        'feedback',
        row.feedbackDoneAt !== null || row.feedbackSkippedAt !== null,
        () => stepFeedback(held, dependencies.feedback, now),
      ],
      ['credentials', row.credentialsDoneAt !== null, () => stepCredentials(held, now)],
      ['rows', row.rowsDoneAt !== null, () => stepRows(held, now)],
      // (g), the last: owed only where (c) made its call, and not before the second call is due.
      [
        'feedback again',
        row.feedbackSkippedAt !== null || row.feedbackAgainDoneAt !== null,
        () => stepFeedbackAgain(held, dependencies.feedback, now),
      ],
    ];
    for (const [name, done, run] of plan) {
      if (done) continue;
      try {
        const result = await run();
        // Not yet due: the deletion stays open for a later run, which is no failure.
        if (result === 'later') return { steps, completed: false, failed: false };
        // Nothing was owed after all (the deletion was completed by the step before): not a step.
        if (result === 'nothing') continue;
      } catch (error) {
        // The claim was taken over: nothing was written under it, and the run that took it goes on.
        if (error instanceof ClaimLost) return { steps, completed: false, failed: false };
        console.error(`account deletion ${id}: step ${name} not done (${faultOf(error)})`);
        return { steps, completed: false, failed: true };
      }
      steps += 1;
    }
    return { steps, completed: true, failed: false };
  } finally {
    // Whatever happened, the next run may take it: unless it finished (the claim went with it), or
    // another run has taken the claim over (the write names this claim).
    await db()
      .accountDeletion.updateMany({ where: { id, claimedAt: claim }, data: { claimedAt: null } })
      .catch((error: unknown) =>
        console.error(`account deletion ${id}: claim not released (${faultOf(error)})`),
      );
  }
}

/**
 * NFR-RE-15, "the steps of an account deletion in Closed α": carries out the steps still owed of
 * every confirmed deletion that is not complete, in order, each deletion under a claim. One that
 * fails does not hold the others back. `now` is when the run began, for the tests; each claim is
 * marked with the time that has passed since on this instance's clock.
 *
 * NFR-DP-06: a deletion still open a month after its confirmation is said so, once for each run,
 * with the number and nothing else. What raises an alert for it is not decided (S22-9).
 */
export async function carryOutDeletions(
  now: Date = new Date(),
  dependencies: Dependencies = {},
): Promise<RunOutcome> {
  const began = Date.now();
  const open = await db().accountDeletion.findMany({
    where: { completedAt: null },
    select: { id: true, requestedAt: true },
    orderBy: [{ requestedAt: 'asc' }, { id: 'asc' }],
  });
  const outcome: RunOutcome = { steps: 0, completed: 0, failed: 0, overdue: 0, stuckAtFeedback: 0 };
  for (const { id, requestedAt } of open) {
    const claim = new Date(now.getTime() + Date.now() - began);
    let completed = false;
    try {
      const result = await carryOut(id, claim, dependencies);
      outcome.steps += result.steps;
      completed = result.completed;
      if (completed) outcome.completed += 1;
      if (result.failed) outcome.failed += 1;
    } catch (error) {
      // A step that failed has said which and how (`carryOut`); anything else is said here. Either
      // way the deletion is left for the next run, and the others are not held back.
      console.error(`account deletion ${id}: not carried out (${faultOf(error)})`);
      outcome.failed += 1;
    }
    if (!completed && oneMonthAfter(requestedAt) <= now) outcome.overdue += 1;
    // Stuck at a call to the feedback intake, (c) or its repeat (g), for a day. The row is read again, after
    // this run: a run that did the step has fixed it.
    if (!completed && requestedAt.getTime() + FEEDBACK_ALARM_MS <= now.getTime()) {
      const row = await db().accountDeletion.findUnique({
        where: { id },
        select: {
          completedAt: true,
          istoricoDoneAt: true,
          feedbackDoneAt: true,
          feedbackSkippedAt: true,
          rowsDoneAt: true,
          feedbackAgainDoneAt: true,
        },
      });
      if (row && row.completedAt === null && stuckAtDetach(row, now)) outcome.stuckAtFeedback += 1;
    }
  }
  if (outcome.stuckAtFeedback > 0) {
    console.error(
      `account deletion: ${outcome.stuckAtFeedback} confirmed deletion${outcome.stuckAtFeedback === 1 ? ' has' : 's have'} been stuck at a call to the feedback intake for 24 hours`,
    );
  }
  if (outcome.overdue > 0) {
    console.error(
      `account deletion: ${outcome.overdue} confirmed deletion${outcome.overdue === 1 ? ' is' : 's are'} open past the one-month limit (NFR-DP-06)`,
    );
  }
  return outcome;
}
