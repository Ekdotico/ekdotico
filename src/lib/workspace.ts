// The personal workspace of an account (FR-AU-09; register D61). It is created
// in the transaction that creates the account (FR-AU-90). "Never two" rests on
// the unique index on `Workspace.ownerId`, not on anything here.
import type { Prisma } from '../generated/prisma/client.ts';
import { db } from './db.ts';

/** Inside the transaction that creates the account. */
export async function createPersonalWorkspace(tx: Prisma.TransactionClient, ownerId: string): Promise<void> {
  await tx.workspace.create({ data: { type: 'PERSONAL', ownerId } });
}

/**
 * The backstop of FR-AU-09: "at the account's first authenticated request
 * where it is missing". Safe to call on every request and from two at once:
 * the insert does nothing where the account has its workspace, and the index
 * refuses a second. Returns the workspace's identifier.
 */
export async function ensurePersonalWorkspace(userId: string): Promise<string> {
  const existing = await db().workspace.findUnique({ where: { ownerId: userId }, select: { id: true } });
  if (existing) return existing.id;
  // INSERT … ON CONFLICT DO NOTHING: of two calls at once, one inserts and neither fails.
  await db().workspace.createMany({ data: [{ type: 'PERSONAL', ownerId: userId }], skipDuplicates: true });
  const { id } = await db().workspace.findUniqueOrThrow({ where: { ownerId: userId }, select: { id: true } });
  return id;
}
