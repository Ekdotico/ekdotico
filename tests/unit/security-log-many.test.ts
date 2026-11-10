// P-11: the batch writer keeps the rules of the single one (NFR-SE-19): a kind outside the list writes
// nothing, only the three named fields are stored, and it writes in the client it is given.
import { expect, it, vi } from 'vitest';

vi.mock('../../src/lib/db.ts', () => ({ db: () => ({}) }));
const { securityLogManyIn } = await import('../../src/lib/security-log.ts');

const client = () => {
  const createMany = vi.fn(async () => ({ count: 0 }));
  return { createMany, transaction: { securityLogEntry: { createMany } } as never };
};

it('writes all the entries in one statement, with the three fields and no more', async () => {
  const { createMany, transaction } = client();
  await securityLogManyIn(transaction, [
    { kind: 'collaborators_changed', userId: 'u', documentId: 'd1', extra: 'x' } as never,
    { kind: 'collaborators_changed', userId: 'u', documentId: 'd2' },
  ]);
  expect(createMany).toHaveBeenCalledTimes(1);
  expect(createMany).toHaveBeenCalledWith({
    data: [
      { kind: 'collaborators_changed', userId: 'u', documentId: 'd1' },
      { kind: 'collaborators_changed', userId: 'u', documentId: 'd2' },
    ],
  });
});

it('writes nothing, and rejects, where one kind is outside the list', async () => {
  const { createMany, transaction } = client();
  await expect(
    securityLogManyIn(transaction, [{ kind: 'collaborators_changed' }, { kind: 'nonsense' as never }]),
  ).rejects.toThrow('security log: unknown kind');
  expect(createMany).not.toHaveBeenCalled();
});

it('writes nothing for no entries', async () => {
  const { createMany, transaction } = client();
  await securityLogManyIn(transaction, []);
  expect(createMany).not.toHaveBeenCalled();
});
