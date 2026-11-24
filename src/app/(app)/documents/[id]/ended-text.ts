// The words of a document that closed in this tab (FR-ED-41). The second sentence is said only when
// changes were unsent at the moment it closed (src/lib/collab/client.ts, `hadUnsent`).
export const CLOSED = 'Ekdotico closed the document in this tab.';
export const DISCARDED = 'Ekdotico discarded the changes that it had not yet sent.';

export const closedText = (hadUnsent: boolean | undefined): string =>
  hadUnsent ? `${CLOSED} ${DISCARDED}` : CLOSED;
