// What an action that asks for the prompt asks again INSIDE its transaction (FR-ED-47, FR-AU-92; D285; register
// Q82 point 6; docs@da33e58). Its own file, with type imports only, so that the modules that make an offer load
// nothing of the identity library; `askPrompt` (./prompt.ts) is what builds one.
import type { Prisma } from '../../generated/prisma/client.ts';

/**
 * `standing`: that the password and the session still stand, each as a write (`standing` of
 * src/lib/auth/two-factor.ts). `spend`: where a recovery code was entered, the write that spends it, made once
 * every refusal of the action is behind it, so that a refused action leaves the code its owner's and the code
 * that opened one action opens no second.
 */
export interface Guard {
  standing: (tx: Prisma.TransactionClient) => Promise<'held' | 'ended' | 'outrun'>;
  spend: ((tx: Prisma.TransactionClient) => Promise<boolean>) | null;
}

/** What an action answers when its guard refuses it; the route answers it (`guardAnswer`). */
export type GuardRefusal = { outcome: 'ended' } | { outcome: 'outrun' } | { outcome: 'code_gone' };

/** Asks the guard at the start of the action's transaction: null where the action may go on. */
export async function guardRefusal(tx: Prisma.TransactionClient, guard: Guard): Promise<GuardRefusal | null> {
  const held = await guard.standing(tx);
  return held === 'held' ? null : { outcome: held };
}

/** Spends the recovery code that was entered, where one was; null where the action may go on. */
export async function guardSpend(tx: Prisma.TransactionClient, guard: Guard): Promise<GuardRefusal | null> {
  if (guard.spend && !(await guard.spend(tx))) return { outcome: 'code_gone' };
  return null;
}
