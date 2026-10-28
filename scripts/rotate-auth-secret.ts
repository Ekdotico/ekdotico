// Step 3 of docs/operations/secret-rotation.md (NFR-SE-17 (a), (e); docs/plan/slice-27.md, S27-6): re-seals
// the second factor of every account from the old AUTH_SECRET to the new one, and ends every session, in one
// transaction. `AUTH_SECRET` is the key under which TwoFactor.secret and TwoFactor.backupCodes are sealed
// (src/lib/auth/two-factor.ts); changing it alone would leave every one unreadable.
//
//   OLD_AUTH_SECRET=… NEW_AUTH_SECRET=… DATABASE_URL=… node scripts/rotate-auth-secret.ts          (counts, changes nothing)
//   OLD_AUTH_SECRET=… NEW_AUTH_SECRET=… DATABASE_URL=… node scripts/rotate-auth-secret.ts --apply
//
// DATABASE_URL is the runtime role's (ekdotico_app). Nothing is printed but counts: no secret, no row. A row that
// opens under neither secret stops the whole run and nothing is changed. A row that opens under the new secret
// already is left as it is, so a run that is repeated after a stop changes nothing twice.
import { PrismaPg } from '@prisma/adapter-pg';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { PrismaClient } from '../src/generated/prisma/client.ts';

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
  if (oldKey === newKey) throw new Error('The old and the new secret are the same.');
  if (newKey.length < 32) throw new Error('The new secret has under 32 characters.');
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
          throw new Error('A second factor opens under neither secret; nothing was changed.');
        }
      }
      result.sessionsEnded = (await tx.session.deleteMany({})).count;
      if (!apply) throw stop;
    });
  } catch (error) {
    if (error !== stop) throw error;
  }
  return result;
}

if (import.meta.main) {
  const { OLD_AUTH_SECRET, NEW_AUTH_SECRET, DATABASE_URL } = process.env;
  if (!OLD_AUTH_SECRET || !NEW_AUTH_SECRET || !DATABASE_URL) {
    console.error('rotate: refused: OLD_AUTH_SECRET, NEW_AUTH_SECRET and DATABASE_URL must be set.');
    process.exit(2);
  }
  const apply = process.argv.includes('--apply');
  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DATABASE_URL }, { schema: 'ekdotico' }),
  });
  try {
    const done = await rotate(db, OLD_AUTH_SECRET, NEW_AUTH_SECRET, apply);
    console.log(
      `rotate: ${apply ? 'done' : 'dry run, nothing changed'}: ${done.rows} second factors, ${done.resealed} re-sealed, ` +
        `${done.alreadyNew} already under the new secret, ${done.sessionsEnded} sessions ended`,
    );
  } catch (error) {
    console.error(
      `rotate: failed (${error instanceof Error ? error.message.split('\n')[0]!.replaceAll(OLD_AUTH_SECRET, '[removed]').replaceAll(NEW_AUTH_SECRET, '[removed]') : 'Error'})`,
    );
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
