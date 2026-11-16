// Step 3 of docs/operations/secret-rotation.md (NFR-SE-17 (a), (e); docs/plan/slice-27.md, S27-6): re-seals
// the second factor of every account from the old AUTH_SECRET to the new one, and ends every session, in one
// transaction. `AUTH_SECRET` is the key under which TwoFactor.secret and TwoFactor.backupCodes are sealed
// (src/lib/auth/two-factor.ts); changing it alone would leave every one unreadable.
//
//   read -rs OLD_AUTH_SECRET && export OLD_AUTH_SECRET      (and NEW_AUTH_SECRET, DATABASE_URL the same way:
//   typed at a prompt, so that none is in the command line, the history of the shell or `ps`)
//   node scripts/rotate-auth-secret.ts            (counts, changes nothing)
//   node scripts/rotate-auth-secret.ts --apply
//
// `--exposed` is step 3a of the same document, for the case in which the database and AUTH_SECRET have both been
// exposed: nothing is re-sealed; every second factor and password ends, in one transaction (see `exposure`).
//
// DATABASE_URL is the runtime role's (ekdotico_app). Nothing is printed but counts: no secret, no row. A row that
// opens under neither secret stops the whole run and nothing is changed. A row that opens under the new secret
// already is left as it is, so a run that is repeated after a stop re-seals no row twice. It ends every session
// each time it runs, those made since the run before included. A fault is said by its class and code, never by
// its message, which could name the host or the role.
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashPassword, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { TWO_FACTOR_OFFER } from '../src/lib/auth/enrolment-offer-text.ts';
import { describeError, ToolFault } from './backup-tools.ts';

/** The most a run may take: the transaction of Prisma ends at 5 seconds unless it is told otherwise, and a deployment may hold many accounts. */
const TRANSACTION = { timeout: 10 * 60_000, maxWait: 15_000 };

const opens = async (key: string, data: string): Promise<string | null> =>
  symmetricDecrypt({ key, data }).then(
    (plain) => plain,
    () => null,
  );

export interface Rotation {
  rows: number;
  resealed: number;
  alreadyNew: number;
  sessionsEnded: number;
}

/** Re-seals every row. With `apply` false the transaction is rolled back, so that the counts are the counts of the real run. */
export async function rotate(
  db: PrismaClient,
  oldKey: string,
  newKey: string,
  apply: boolean,
): Promise<Rotation> {
  if (oldKey === newKey) throw new ToolFault('The old and the new secret are the same.');
  if (newKey.length < 32) throw new ToolFault('The new secret has under 32 characters.');
  const result: Rotation = { rows: 0, resealed: 0, alreadyNew: 0, sessionsEnded: 0 };
  const stop = new Error('dry run');
  try {
    await db.$transaction(async (tx) => {
      const factors = await tx.twoFactor.findMany({ select: { id: true, secret: true, backupCodes: true } });
      result.rows = factors.length;
      for (const factor of factors) {
        const secret = await opens(oldKey, factor.secret);
        const codes = await opens(oldKey, factor.backupCodes);
        if (secret !== null && codes !== null) {
          await tx.twoFactor.update({
            where: { id: factor.id },
            data: {
              secret: await symmetricEncrypt({ key: newKey, data: secret }),
              backupCodes: await symmetricEncrypt({ key: newKey, data: codes }),
            },
          });
          result.resealed++;
        } else if (
          (await opens(newKey, factor.secret)) !== null &&
          (await opens(newKey, factor.backupCodes)) !== null
        ) {
          result.alreadyNew++;
        } else {
          // Never the id or the value: a count says enough, and a log must hold neither (NFR-SE-19).
          throw new ToolFault('A second factor opens under neither secret; nothing was changed.');
        }
      }
      result.sessionsEnded = (await tx.session.deleteMany({})).count;
      if (!apply) throw stop;
    }, TRANSACTION);
  } catch (error) {
    if (error !== stop) throw error;
  }
  return result;
}

export interface Exposure {
  /** Second factors deleted. */
  factors: number;
  /** Accounts whose password was ended. */
  passwords: number;
  sessionsEnded: number;
  /** Open links and second steps deleted (reset, address, lock link, second step). */
  linksEnded: number;
  /** Accounts that were offered enrolment: those of them that had a second factor and are not of the founding team. */
  offered: number;
}

/**
 * NFR-SE-17 (e), register D302 and Q82 points 1 to 3 (docs@da33e58): the rotation for the case in which the database
 * AND `AUTH_SECRET` have both been exposed. Re-sealing protects nothing there, since whoever holds both opens every
 * sealed value, so nothing is re-sealed. In ONE transaction, applied together or not at all:
 *
 * - every second factor is deleted, and every account that held one has two-factor authentication off;
 * - every password ends: the stored hash is replaced by that of a password nobody has, so that each account can sign in
 *   again only through a reset link sent to its verified address (FR-AU-03), the database exposed holding the hashes;
 * - every session ends, and every open link and second step (they are rows of `Verification`) is deleted;
 * - an account that had a second factor and is not of the founding team is offered enrolment (a notification, which it
 *   may leave); one of the founding team needs no row: FR-AU-83's gate stops it, after the reset, until it enrols.
 *
 * `foundingTeam` is the list of addresses of the process (`FOUNDING_TEAM_EMAILS`), compared without regard to case.
 * The new secret is checked here as `rotate` checks it, and the deployment installs it in the same step of the
 * procedure, which stops both processes before this runs and starts them with the new value after it
 * (docs/operations/secret-rotation.md, step 3a). With `apply` false the transaction is rolled back, so that the counts
 * are the counts of the real run.
 */
export async function exposure(
  db: PrismaClient,
  newKey: string,
  apply: boolean,
  foundingTeam: readonly string[],
  oldKey?: string,
): Promise<Exposure> {
  if (oldKey !== undefined && oldKey === newKey)
    throw new ToolFault('The old and the new secret are the same.');
  if (newKey.length < 32) throw new ToolFault('The new secret has under 32 characters.');
  const team = new Set(foundingTeam.map((address) => address.trim().toLowerCase()).filter(Boolean));
  // A password no one has: a hash of 256 random bits, made once and put on every account. It verifies for nothing.
  const ended = await hashPassword(randomBytes(32).toString('hex'));
  const result: Exposure = { factors: 0, passwords: 0, sessionsEnded: 0, linksEnded: 0, offered: 0 };
  const stop = new Error('dry run');
  try {
    await db.$transaction(async (tx) => {
      const holders = await tx.twoFactor.findMany({
        select: { userId: true, user: { select: { email: true } } },
      });
      result.factors = (await tx.twoFactor.deleteMany({})).count;
      await tx.user.updateMany({ where: { twoFactorEnabled: true }, data: { twoFactorEnabled: false } });
      result.passwords = (
        await tx.account.updateMany({ where: { providerId: 'credential' }, data: { password: ended } })
      ).count;
      result.sessionsEnded = (await tx.session.deleteMany({})).count;
      result.linksEnded = (await tx.verification.deleteMany({})).count;
      const offers = holders.flatMap(({ userId, user }) =>
        user.email !== null && !team.has(user.email.toLowerCase())
          ? [{ recipientId: userId, kind: TWO_FACTOR_OFFER, payload: {} }]
          : [],
      );
      result.offered = (await tx.notification.createMany({ data: offers })).count;
      if (!apply) throw stop;
    }, TRANSACTION);
  } catch (error) {
    if (error !== stop) throw error;
  }
  return result;
}

if (import.meta.main) {
  const { OLD_AUTH_SECRET, NEW_AUTH_SECRET, DATABASE_URL, FOUNDING_TEAM_EMAILS } = process.env;
  const exposed = process.argv.includes('--exposed');
  // After an exposure of the database and the secret the old value opens nothing that is kept, so it is not needed;
  // the list of the founding team is, to tell who is offered enrolment (it is the process's own, never a request's).
  if (
    !NEW_AUTH_SECRET ||
    !DATABASE_URL ||
    (exposed ? FOUNDING_TEAM_EMAILS === undefined : !OLD_AUTH_SECRET)
  ) {
    console.error(
      exposed
        ? 'rotate: refused: NEW_AUTH_SECRET, DATABASE_URL and FOUNDING_TEAM_EMAILS must be set.'
        : 'rotate: refused: OLD_AUTH_SECRET, NEW_AUTH_SECRET and DATABASE_URL must be set.',
    );
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  // Review of PR 80, item 2: the cookie cache is on (NFR-SE-17 (c)), so a process that still holds the exposed
  // AUTH_SECRET honours a cached or forged cookie after the run. The operator says, in a flag, that both are stopped.
  if (exposed && apply && !process.argv.includes('--processes-stopped')) {
    console.error(
      'rotate: refused: --exposed --apply needs --processes-stopped, which states that the application and the collaboration server are both stopped. Nothing was changed.',
    );
    process.exit(2);
  }
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema: 'ekdotico' }),
  });
  try {
    if (exposed) {
      const done = await exposure(
        db,
        NEW_AUTH_SECRET,
        apply,
        (FOUNDING_TEAM_EMAILS ?? '').split(','),
        OLD_AUTH_SECRET,
      );
      console.log(
        `rotate: ${apply ? 'done' : 'dry run, nothing changed'}, exposed: ${done.factors} second factors deleted, ` +
          `${done.passwords} passwords ended, ${done.sessionsEnded} sessions ended, ${done.linksEnded} links ended, ` +
          `${done.offered} accounts offered enrolment`,
      );
    } else {
      const done = await rotate(db, OLD_AUTH_SECRET!, NEW_AUTH_SECRET, apply);
      console.log(
        `rotate: ${apply ? 'done' : 'dry run, nothing changed'}: ${done.rows} second factors, ${done.resealed} re-sealed, ` +
          `${done.alreadyNew} already under the new secret, ${done.sessionsEnded} sessions ended`,
      );
    }
  } catch (error) {
    console.error(`rotate: failed (${describeError(error)})`);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
