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
  noOtherEditor: 'No other Editor. Offer it to one person, or clear it.',
  ready: 'Not offered yet.',
  deleted: 'Deleted. Restore it or delete it permanently before it can be offered.',
  beingDeleted: 'Being deleted. Its day has come and it cannot be offered.',
  notTransferable: 'Cannot be transferred in this release.',
  accepted: (name: string) => `Accepted by ${name}. You are an Editor of it.`,
  acceptedHeading: 'Accepted',
  nobodyToOffer: 'No new offer can be made in this way.',
} as const;

export const TRANSFER_DIALOG = {
  title: TRANSFER_ALL,
  legend: 'Offer ownership',
  hint: 'The longest-standing Editor of a document is the one who has held the Editor role on it for the longest unbroken time.',
  person: 'Person',
  personOption: (name: string, documents: number) =>
    `${name} (${plural(documents, 'document', 'documents')})`,
  choosePerson: 'Choose a person to see how many documents can be offered to them.',
  choose: 'Choose a person',
  acceptance: (days: number) =>
    `Ownership changes only when an Editor accepts. You stay the Owner of each document until then. Each offer is open for ${plural(days, 'day', 'days')}.`,
  cancel: 'Cancel',
  pending: 'Offering ownership…',
} as const;

const already = (kept: number, tense: 'has' | 'had') =>
  `${plural(kept, 'document', 'documents')} already ${kept === 1 ? tense : tense === 'has' ? 'have' : 'had'} an offer, which stands.`;

/**
 * What the confirmation names (FR-AU-92): the number of documents offered, and the number that cannot be offered.
 * The offered are the new offers this choice makes; a document that already has an offer keeps it and is said apart.
 * `personName` is null where "To one person" is chosen and no person is.
 */
export function confirmation({
  mode,
  personName,
  offered,
  kept,
  cannot,
}: {
  mode: 'longest' | 'person';
  personName: string | null;
  offered: number;
  kept: number;
  cannot: number;
}): string[] {
  if (mode === 'person' && personName === null) return [TRANSFER_DIALOG.choosePerson];
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
  if (kept > 0) lines.push(already(kept, 'has'));
  if (cannot > 0) {
    lines.push(
      `${plural(cannot, 'document', 'documents')} cannot be offered. The list on the page says why.`,
    );
  }
  return lines;
}

/** The control of the confirmation: "Offer 3 documents", "Offer 1 document". */
export const confirmControl = (offered: number) => `Offer ${plural(offered, 'document', 'documents')}`;

/** The status after the action. `offered` new offers were made; `kept` of the documents already had an offer, which stands. */
export function offeredStatement({ offered, kept }: { offered: number; kept: number }): string {
  if (offered === 0)
    return kept > 0 ? `No new offer was made. ${already(kept, 'had')}` : 'No offer was made.';
  const told =
    offered === 1
      ? 'Ownership of 1 document offered. The Editor has been told by a notification and by email.'
      : `Ownership of ${offered} documents offered. Each Editor has been told by a notification and by email.`;
  return kept > 0 ? `${told} ${already(kept, 'had')}` : told;
}

/** The sentence of the dialog that asks for the prompt of FR-AU-92 (D285), after the confirmation. For the owner's approval. */
export const TRANSFER_PROMPT = {
  password: 'Enter your current password to confirm.',
  passwordAndCode: 'Enter your current password and a code to confirm.',
};

/** What the route answers with, for a program, and the browser shows as it is given. */
export const TRANSFER_MESSAGES = {
  shape:
    'The request must hold how to choose the new Owner, the identifiers of the documents, and nothing else. No offer was made.',
  // FR-AU-92, D285; register Q82 point 6. For the owner's approval.
  password: 'No offer was made. Enter your current password to confirm.',
  passwordAndCode: 'No offer was made. Enter your current password and a code to confirm.',
  changed:
    'The documents of this account, or the Editors on them, are no longer the ones you were shown. The page now shows what they are. Check it, and confirm again. No offer was made.',
  nothing: 'No document of this account can be offered in this way. No offer was made.',
  noSuchPerson:
    'This person is not an Editor of any document of this account. The page now shows the Editors. No offer was made.',
  overLimit: (most: number, wanted: number) =>
    `A transfer can email at most ${most} people in any hour, counted over the last hour, and each offer made from a sharing page counts as one of them. This one would email ${wanted}. No offer was made. Offer the documents to one person at a time instead, or offer some from their sharing pages over more than one hour, and try again.`,
  tooMany: (most: number) =>
    `A transfer names at most ${most.toLocaleString('en-GB')} documents. No offer was made.`,
} as const;
