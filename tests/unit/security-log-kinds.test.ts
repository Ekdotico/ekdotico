// NFR-SE-19; the owner's decision of 12 October 2026 (R38; register row D153,
// pending): the entry of a change is written in the transaction of the
// change, and the entry of a refusal outside any. The rule is held by the
// types of the two writers, so what fails where it is broken is `pnpm
// typecheck`: each directive below reports an error once the line under it is
// allowed. What is run here is the last test alone.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { db } from '../../src/lib/db.ts';
import type { securityLog, securityLogIn } from '../../src/lib/security-log.ts';

type Outside = Parameters<typeof securityLog>[0]['kind'];
type Inside = Parameters<typeof securityLogIn>[1]['kind'];
type Client = Parameters<typeof securityLogIn>[0];
type Transaction = Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0];

// @ts-expect-error The entry of a change is not written outside its transaction.
const deletion: Outside = 'document_deleted';
// @ts-expect-error Nor is a step of an account deletion (FR-AU-58).
const step: Outside = 'account_deletion_credentials_deleted';
// @ts-expect-error A refusal is the entry of no change: a rollback would take it.
const refusal: Inside = 'forbidden';
// @ts-expect-error A kind is a change only where it is named as one, not by how it begins.
const unnamed: Inside = 'account_deletion_of_a_later_release';
// @ts-expect-error The client of no transaction is not one to write the entry of a change with.
const outside = (client: ReturnType<typeof db>): Client => client;

const change: Inside = 'owner_changed';
const limit: Outside = 'rate_limit_reached';
const inside = (client: Transaction): Client => client;

it('names each kind for one writer', () => {
  expect([deletion, step, refusal, unnamed, change, limit, outside, inside]).toHaveLength(8);
});

const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(directory, entry.name)) : [join(directory, entry.name)],
  );

it('writes an entry nowhere but in the two writers', () => {
  // Not the generated client (src/generated, which is not committed): its comments name every call.
  const generated = join('src', 'generated');
  const writing = filesUnder('src').filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !file.startsWith(generated) &&
      readFileSync(file, 'utf8').includes('securityLogEntry.create'),
  );
  expect(writing).toEqual([join('src', 'lib', 'security-log.ts')]);
});
