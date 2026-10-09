// What the document page hands to the browser: the editor, loaded when this
// page is opened and by no other page. The editor, Yjs and the connection are
// most of the application's script, and the list of documents, the settings
// and the sign-in pages do not carry them.
'use client';

import dynamic from 'next/dynamic';
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

export function DocumentView(props: { documentId: string; canEdit: boolean; errorAfterMs: number }) {
  return <Editor {...props} />;
}
