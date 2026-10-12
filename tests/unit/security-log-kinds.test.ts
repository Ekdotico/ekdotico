// NFR-SE-19; R38: the entry of a change is written in the transaction of the
// change, and the entry of a refusal outside any. The rule is held by the
// types of the two writers, so what fails where it is broken is `pnpm
// typecheck`: each directive below reports an error once the line under it is
// allowed. The test itself only keeps the file among those that are run.
import { expect, it } from 'vitest';
import type { securityLog, securityLogIn } from '../../src/lib/security-log.ts';

type Outside = Parameters<typeof securityLog>[0]['kind'];
type Inside = Parameters<typeof securityLogIn>[1]['kind'];

// @ts-expect-error The entry of a change is not written outside its transaction.
const deletion: Outside = 'document_deleted';
// @ts-expect-error Nor is a step of an account deletion (FR-AU-58).
const step: Outside = 'account_deletion_credentials_deleted';
// @ts-expect-error A refusal is the entry of no change: a rollback would take it.
const refusal: Inside = 'forbidden';

const change: Inside = 'owner_changed';
const limit: Outside = 'rate_limit_reached';

it('names each kind for one writer', () => {
  expect([deletion, step, refusal, change, limit]).toHaveLength(5);
});
