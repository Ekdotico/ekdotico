import { ROLE_NAME, type DocumentRole } from '../../../../lib/documents/permissions.ts';

// F10 (ekdotico#89): where a browser that cannot edit would show the keys of a writer, one neutral line says
// that the text is for reading and names the role. Approved by the owner on 17 November 2026 (ui-t3-reader).
export const readerLine = (role: DocumentRole) =>
  `You can read this document. Your role on it is ${ROLE_NAME[role]}.`;
