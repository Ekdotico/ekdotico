// The row of the people who have the document open (FR-ED-17; the owner's
// decisions of 18 October 2026, register rows S14-1, S14-6, F14-1, PR-1):
// their pictures, each the initials on the colour of the person's connection,
// which is the colour of their cursor, and to a screen reader a list that reads
// each person's name and, where the server sent it, role.
//
// WHERE: in the header of the document, beside "Sharing". The two answer one
// question, who is on this document, and the header is the one place of the
// page that stays above the text and is reached before it, by a reader and by a
// screen reader alike. The page renders the empty place (`PEOPLE_SLOT`) and the
// editor, which holds the connection, fills it; the row is a portal into it.
//
// The component is domico's `AvatarStack`, which is read as a list in reading
// order and is not a tab stop, since nothing in it acts. Its words are ours.
'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { CollaboratorSlot } from '@ekdotico/domico/tokens';
import { AvatarStack } from '@ekdotico/domico/components';
import type { Person } from '../../../../lib/collab/protocol.ts';
import { ROLE_NAME } from '../../../../lib/documents/permissions.ts';
import { PEOPLE_SLOT } from './people-slot.ts';

// For the owner's approval (docs/plan/presence-row.md, section 5).
const LABEL = 'People in this document';
const YOU = 'you';
const MORE = (hidden: number) => (hidden === 1 ? 'and 1 more person' : `and ${hidden} more people`);

/**
 * The row of `people`, in the header. Nothing where the server has sent no
 * list, and nothing where the header has no place for it.
 */
export function PeopleRow({ people }: { people: readonly Person[] | undefined }) {
  // The place is in the page, and the editor is made after it and in the browser alone (./document-view.tsx).
  const [place] = useState(() => document.getElementById(PEOPLE_SLOT));
  if (!place || !people || people.length === 0) return null;
  return createPortal(
    <AvatarStack
      label={LABEL}
      // A slot is one connection's own for as long as it is open, so it names the person in the list.
      people={people.map(({ slot, name, role, you }) => ({
        id: String(slot),
        name,
        // `isSlot` of src/lib/collab/presence.ts has read it: 1 to 10.
        collaboratorSlot: slot as CollaboratorSlot,
        // Only where the server sent it: a role that may not see the people is shown none (register row PR-2).
        ...(role ? { role: ROLE_NAME[role] } : {}),
        ...(you ? { you: YOU } : {}),
      }))}
      more={MORE}
    />,
    place,
  );
}
