// What the document page hands to the browser: the editor, loaded when this
// page is opened and by no other page. The editor, Yjs and the connection are
// most of the application's script, and the list of documents, the settings
// and the sign-in pages do not carry them.
'use client';

import dynamic from 'next/dynamic';
import type { DocumentRole } from '../../../../lib/documents/permissions.ts';
import pageStyles from '../../../pages.module.css';

const Editor = dynamic(() => import('./editor.tsx'), {
  // There is no document on the server to render: its state arrives over the connection.
  ssr: false,
  loading: () => (
    <p role="status" className={pageStyles.text}>
      Opening the document…
    </p>
  ),
});

export function DocumentView(props: {
  documentId: string;
  /** The role of the account on the document, named in the line a reader is shown in place of the hint (F10). */
  role: DocumentRole;
  canEdit: boolean;
  errorAfterMs: number;
  /** NFR-SE-18: how many days an image out of the document is kept, for the words of a block whose image is gone. */
  imageDays: number;
  /** FR-AU-91: the day a clearing deletes the document (ISO 8601, UTC), or null. */
  deletedOn: string | null;
  /** The document was deleted by its Owner before the clearing (a former collaborator reads it in the period). */
  alreadyDeleted: boolean;
}) {
  return <Editor {...props} />;
}
