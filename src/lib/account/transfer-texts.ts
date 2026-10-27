// The words of the transfer of all documents (FR-AU-92), which the server and the browser both show. Imports
// nothing, so that a page of the browser can take them. Written under the Expression Guidelines for the owner's
// approval (plan Q6; docs/plan/slice-24.md, section 7). The names of the two options, and the subject and the
// text of the email, are FR-AU-92's own, verbatim (the email's are in ./transfer-email.ts).

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** FR-AU-92, verbatim: the two options. */
export const OPTION_LONGEST = 'To the longest-standing Editor';
export const OPTION_PERSON = 'To one person';

/** The name FR-AU-58 and D72 give the action. */
export const TRANSFER_ALL = 'Transfer ownership of all documents';

export const TRANSFER_SCREEN = {
  heading: TRANSFER_ALL,
  lead: 'Offer the ownership of every document this account owns, in one action. Each Editor must accept: ownership changes only when they do, and the account cannot be deleted until every document has been accepted or cleared. When an Editor accepts, you become an Editor of that document.',
  listHeading: 'Your documents and their offers',
  none: 'This account owns no document.',
  deletedLink: 'Deleted documents',
  // The states of FR-AU-92, one sentence each. `name` is the display name of the Editor, or "Deleted account".
  offered: (name: string) => `Offered to ${name}`,
  until: 'open until',
  declined: (name: string) => `${name} declined the offer. Offer it again to the next Editor, or clear it.`,
  expired: (name: string) => `The offer to ${name} expired. Offer it again to the next Editor, or clear it.`,
  noEditor: 'Without an Editor. Give a collaborator the Editor role, or clear it.',
  ready: 'Not offered yet.',
  deleted: 'Deleted. Restore it or delete it permanently before it can be offered.',
  beingDeleted: 'Being deleted. Its day has come and it cannot be offered.',
  notTransferable: 'Cannot be transferred in this release.',
  accepted: (name: string) => `Accepted by ${name}. You are an Editor of it.`,
  acceptedHeading: 'Accepted',
  nobodyToOffer: 'No document can be offered in this way. No offer will be made.',
} as const;

export const TRANSFER_DIALOG = {
  title: TRANSFER_ALL,
  legend: 'Offer ownership',
  hint: 'The longest-standing Editor of a document is the one who has held the Editor role on it for the longest unbroken time.',
  person: 'Person',
  personOption: (name: string, documents: number) =>
    `${name} (${plural(documents, 'document', 'documents')})`,
  keeps: 'A document that already has an offer keeps it, and is counted as offered.',
  acceptance: (days: number) =>
    `Ownership changes only when an Editor accepts. You stay the Owner of each document until then. Each offer is open for ${plural(days, 'day', 'days')}.`,
  cancel: 'Cancel',
  pending: 'Offering ownership…',
} as const;

/** What the confirmation names (FR-AU-92): the number of documents offered, and the number that cannot be offered. */
export function confirmation({
  mode,
  personName,
  offered,
  cannot,
}: {
  mode: 'longest' | 'person';
  personName: string;
  offered: number;
  cannot: number;
}): string[] {
  const lines: string[] = [];
  if (offered === 0) {
    lines.push(TRANSFER_SCREEN.nobodyToOffer);
  } else {
    lines.push(
      mode === 'longest'
        ? `You are offering the ownership of ${plural(offered, 'document', 'documents')}, each to its longest-standing Editor.`
        : `You are offering the ownership of ${plural(offered, 'document', 'documents')} to ${personName}.`,
    );
  }
  if (cannot > 0) {
    lines.push(
      `${plural(cannot, 'document', 'documents')} cannot be offered. The list on the page says why.`,
    );
  }
  return lines;
}

/** The control of the confirmation: "Offer 3 documents", "Offer 1 document". */
export const confirmControl = (offered: number) => `Offer ${plural(offered, 'document', 'documents')}`;

/** The status after the action. `kept` of the documents already had an offer, which stands. */
export function offeredStatement({ offered, kept }: { offered: number; kept: number }): string {
  const total = offered + kept;
  const told =
    total === 1
      ? 'Ownership of 1 document offered. The Editor has been told by a notification and by email.'
      : `Ownership of ${total} documents offered. Each Editor has been told by a notification and by email.`;
  return kept > 0 ? `${told} ${kept} already had an offer, which stands.` : told;
}

/** What the route answers with, for a program, and the browser shows as it is given. */
export const TRANSFER_MESSAGES = {
  shape:
    'The request must hold how to choose the new Owner, the identifiers of the documents, and nothing else. No offer was made.',
  changed:
    'The documents of this account, or the Editors on them, are no longer the ones you were shown. Reload the page, check them, and confirm again. No offer was made.',
  nothing: 'No document of this account can be offered in this way. No offer was made.',
  noSuchPerson:
    'This person is not an Editor of any document of this account. Reload the page to see the Editors. No offer was made.',
  overLimit: (most: number, wanted: number) =>
    `An Owner can make at most ${most} offers of ownership in any hour, and this would make ${wanted}. No offer was made. Clear some of the documents, or offer some from their sharing pages, and try again.`,
  tooMany: (most: number) =>
    `A transfer names at most ${most.toLocaleString('en-GB')} documents. No offer was made.`,
} as const;
