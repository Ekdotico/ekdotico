// The one-off check of stored addresses (the owner's decision of 9 October
// 2026; docs/operations/deployment.md, "Before a deployment that holds
// accounts created under an earlier rule"). An address is stored in its one
// spelling and under the one rule of an address (FR-AU-02;
// src/lib/field-text.ts). An account created before that rule, or before a
// change to it, may hold an address the rule would now spell otherwise or
// refuse: it can no longer be signed in to or matched by the list of the
// founding team, and it may stand beside a second account of the same person.
// The same goes for an open admission invitation (FR-AU-89): the person it
// reached would be refused at the sign-up page, or the account made from it
// would not be what the rule allows, and nobody foresaw it.
//
//   node --env-file=.env.local scripts/check-addresses.ts
//
// It reads and changes nothing: no row is migrated here. It prints how many
// accounts hold such an address, and the identifier of each, then how many
// open invitations are for such an address, and the identifier of each, and
// never an address (NFR-SE-19). It exits with 0 where there is none, with 1
// where there is one or more, and with 2 where it could not run.
import { openInvitation } from '../src/lib/admission/invitations.ts';
import { db } from '../src/lib/db.ts';
import { faultOf } from '../src/lib/fault.ts';
import { acceptedAddress } from '../src/lib/field-text.ts';
import { settings } from '../src/lib/settings.ts';

// An account or an invitation that holds no address has none to check.
type Row = { id: string; email: string | null };

// ponytail: every account is read in one query, which is right for a closed α; read in pages should there be very many.
const everyAccount = (): Promise<Row[]> =>
  db().user.findMany({ select: { id: true, email: true }, orderBy: { id: 'asc' } });

// Open as the admission code defines it (src/lib/admission/invitations.ts).
const everyOpenInvitation = (): Promise<Row[]> =>
  db().admissionInvitation.findMany({
    where: openInvitation(new Date()),
    select: { id: true, email: true },
    orderBy: { id: 'asc' },
  });

/** Runs the check and returns the exit code. The parameters are for the tests. */
export async function run(
  print: (line: string) => void = console.log,
  read: () => Promise<Row[]> = everyAccount,
  readInvitations: () => Promise<Row[]> = everyOpenInvitation,
): Promise<number> {
  let rows: Row[];
  let invitations: Row[];
  try {
    // A message of the settings names a setting and never holds a value.
    settings();
  } catch (error) {
    print(`address check: not run. ${(error as Error).message}`);
    return 2;
  }
  try {
    rows = await read();
    invitations = await readInvitations();
  } catch (error) {
    print(`address check: not run (${faultOf(error)})`);
    return 2;
  }
  // The one function: what it returns for a stored address is that address
  // exactly where it is in its one spelling and the rule accepts it.
  const differs = ({ email }: Row) => email !== null && acceptedAddress(email) !== email;
  const differing = rows.filter(differs);
  const differingInvitations = invitations.filter(differs);
  print(
    `address check: ${differing.length} of ${rows.length} accounts hold an address that is not in its one spelling or that the rule of an address refuses`,
  );
  for (const { id } of differing) print(id);
  print(
    `address check: ${differingInvitations.length} of ${invitations.length} open invitations are for an address that is not in its one spelling or that the rule of an address refuses`,
  );
  for (const { id } of differingInvitations) print(id);
  return differing.length + differingInvitations.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = await run();
  // The pool of connections would keep the process open.
  process.exit();
}
