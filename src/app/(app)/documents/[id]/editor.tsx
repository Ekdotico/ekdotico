// The editor of one document (FR-ED-01, FR-ED-02), on its connection to the
// collaboration server (FR-ED-15, FR-ED-16, FR-ED-18), with the sync status
// indicator (FR-ED-22 to FR-ED-24) and the statement of each refusal
// (FR-ED-41; src/lib/collab/protocol.ts).
//
// This module and everything it imports is loaded by the document page alone,
// when that page is opened (./document-view.tsx).
'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { EditorContent, useEditor, type Editor as TextEditor } from '@tiptap/react';
import type { EditorView } from '@tiptap/pm/view';
import type * as Y from 'yjs';
import { tabbableWithin } from '@ekdotico/domico/a11y';
import { Button, Cluster, Dialog, FormFault, Stack, SyncStatus } from '@ekdotico/domico/components';
import { DocumentConnection, syncStatus, type Ending } from '../../../../lib/collab/client.ts';
import { COLLAB_PATH, REFUSAL } from '../../../../lib/collab/protocol.ts';
import pageStyles from '../../../pages.module.css';
import styles from './editor.module.css';
import { BLOCK_CONTROLS, Editable, extensions } from './extensions.tsx';
import { SelectionToolbar } from './selection-toolbar.tsx';

// The fixed texts, word for word.
const IN_SYNC = 'Document autosaves — working version is in sync.'; // FR-ED-24
const AT_CAPACITY =
  'This document has reached its limit of ten connections. Ekdotico tries again every 30 seconds.'; // FR-ED-18

// The requirements give no words for what follows. Written under the
// Expression Guidelines; the owner approves them with the pull request (the
// answer to Q6 of the plan).
const DISCARDED = 'Changes that were not yet sent were discarded.';
const ENDED: Record<Ending, { title: string; text: string; href: string; link: string }> = {
  // FR-ED-41: "a neutral statement that the user's access to the document has ended".
  [REFUSAL.ACCESS_ENDED]: {
    title: 'Access to this document has ended',
    text: `The document is closed in this tab. ${DISCARDED}`,
    href: '/',
    link: 'Open the list of documents',
  },
  // The words of the 404 of a document's routes (src/lib/documents/access.ts).
  [REFUSAL.NO_ACCESS]: {
    title: 'No document was found at this address for this account',
    text: 'Check the address.',
    href: '/',
    link: 'Open the list of documents',
  },
  [REFUSAL.SESSION_ENDED]: {
    title: 'The session has ended',
    text: `The document is closed in this tab. ${DISCARDED}`,
    // `SIGN_IN_PATH` of src/proxy.ts, which is a module of the server.
    href: '/sign-in',
    link: 'Sign in again',
  },
};
// NFR-IC-19: every control of the editor is reached by keyboard. The package
// leaves the key to the application; this is the one editors commonly use.
const KEYS =
  'Alt+F10 moves from the text to the formatting toolbar while text is selected, and otherwise to the controls of the block the cursor is in. Escape returns to the text.';

/** The controls of the innermost block round the cursor that has any. */
function blockControls(view: EditorView): HTMLElement | null {
  const { node } = view.domAtPos(view.state.selection.from);
  let block = (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>(
    '[data-node-view-wrapper]',
  );
  while (block && view.dom.contains(block)) {
    const controls = block.querySelector<HTMLElement>(`[${BLOCK_CONTROLS}]`);
    if (controls?.closest('[data-node-view-wrapper]') === block) return controls;
    block = block.parentElement?.closest<HTMLElement>('[data-node-view-wrapper]');
  }
  return null;
}

/** The text of the document: the editable region, and the toolbar on its selection. */
function Text({
  document,
  editable,
  onEditor,
}: {
  document: Y.Doc;
  editable: boolean;
  /** Told of the editor, for the one who copies its text (FR-ED-24). */
  onEditor: (editor: TextEditor | null) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const keys = useId();
  // What the region says of itself, which follows `editable` (below).
  const readOnly = useRef(!editable);
  const all = useMemo(() => extensions(document), [document]);

  const editor = useEditor({
    extensions: all,
    editable,
    // Rendered in the browser alone: the server has no document to render.
    immediatelyRender: false,
    // FR-ED-14, the Markdown shortcuts, is the next slice's: the library's own
    // set, which is not that list, stays off until then.
    enableInputRules: false,
    enablePasteRules: false,
    editorProps: {
      // NFR-IC-19: the region has a role and a name, says whether it can be
      // edited, and stays in the Tab order when it cannot.
      attributes: () => ({
        class: 'ekd-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': 'Document text',
        'aria-describedby': keys,
        'aria-readonly': String(readOnly.current),
        tabindex: '0',
      }),
      handleKeyDown(view, event) {
        if (!event.altKey || event.key !== 'F10') return false;
        const controls = row.current ?? blockControls(view);
        const first =
          controls?.querySelector<HTMLElement>('input:checked') ?? (controls && tabbableWithin(controls)[0]);
        if (!first) return false;
        first.focus();
        return true;
      },
    },
  });

  useEffect(() => {
    onEditor(editor);
  }, [onEditor, editor]);

  // FR-ED-18: read-only in the error state, and editable again when the
  // connection returns. The focus stays where it was: a region that stops
  // being editable would otherwise drop it.
  useEffect(() => {
    if (!editor || editor.isEditable === editable) return;
    const focused = editor.view.hasFocus();
    readOnly.current = !editable;
    editor.setEditable(editable);
    if (focused) editor.view.dom.focus();
  }, [editor, editable]);

  return (
    <Editable.Provider value={editable}>
      <p id={keys} className={pageStyles.meta}>
        {KEYS}
      </p>
      <div ref={surface} className={styles.surface}>
        {editor ? <SelectionToolbar editor={editor} surface={surface} rowRef={row} /> : null}
        <EditorContent editor={editor} />
      </div>
    </Editable.Provider>
  );
}

/**
 * FR-ED-24: what the indicator shows when it is pressed. The working version
 * is checked against the server's, and where the check does not confirm it,
 * the text can be copied before the document is loaded again from the server.
 */
function SyncCheck({
  result,
  text,
  onClose,
}: {
  result: 'checking' | 'in-sync' | 'unconfirmed';
  text: () => string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (result === 'checking') return <p role="status">Checking the working version against the server…</p>;
  if (result === 'in-sync') {
    return (
      <Stack gap={5}>
        <p role="status">{IN_SYNC}</p>
        <Cluster gap={3}>
          <Button onClick={onClose}>Close</Button>
        </Cluster>
      </Stack>
    );
  }
  return (
    <Stack gap={5}>
      <FormFault
        title="Ekdotico could not confirm that the working version matches the server"
        headingLevel={3}
      >
        <p>
          The working version in this tab may hold changes that the server does not have. Copy the text to
          keep it, then reload the document from the server. Reloading discards the changes that were not
          sent.
        </p>
      </FormFault>
      <Cluster gap={3}>
        <Button
          onClick={() =>
            navigator.clipboard.writeText(text()).then(
              () => setCopied(true),
              () => {},
            )
          }
        >
          Copy text
        </Button>
        <Button variant="destructive" onClick={() => window.location.reload()}>
          Reload document
        </Button>
        <Button onClick={onClose}>Close</Button>
      </Cluster>
      <p role="status">{copied ? 'Text copied.' : ''}</p>
    </Stack>
  );
}

function OpenDocument({ connection, canEdit }: { connection: DocumentConnection; canEdit: boolean }) {
  const state = useSyncExternalStore(connection.subscribe, connection.getState, connection.getState);
  const [check, setCheck] = useState<'checking' | 'in-sync' | 'unconfirmed' | null>(null);
  const editor = useRef<TextEditor | null>(null);
  const keep = useCallback((made: TextEditor | null) => {
    editor.current = made;
  }, []);

  if (state.phase === 'ended' && state.ending) {
    const { title, text, href, link } = ENDED[state.ending];
    // No fault, and not the error state (FR-ED-41). The text and the control
    // that had the focus are gone, so the statement takes it.
    return (
      <FormFault tone="neutral" announce="polite" autoFocus title={title}>
        <p>
          {text} <Link href={href}>{link}</Link>.
        </p>
      </FormFault>
    );
  }

  const status = syncStatus(state);
  return (
    <Stack gap={4}>
      {state.phase === 'capacity' ? (
        // FR-ED-18: "neither the reconnecting state nor the error state".
        <FormFault tone="neutral" announce="polite">
          <p>{AT_CAPACITY}</p>
        </FormFault>
      ) : (
        <SyncStatus
          state={status.state}
          label={status.label}
          onClick={() => {
            setCheck('checking');
            void connection.verify().then((same) => setCheck(same ? 'in-sync' : 'unconfirmed'));
          }}
        />
      )}
      {/* FR-ED-18: read-only in the error state, "until the connection returns". */}
      {state.opened ? (
        <Text document={connection.document} editable={canEdit && state.phase !== 'lost'} onEditor={keep} />
      ) : null}
      <Dialog open={check !== null} onClose={() => setCheck(null)} title="Sync status">
        {check ? (
          <SyncCheck
            result={check}
            // The text as the blocks hold it, a blank line between two.
            text={() => editor.current?.getText() ?? ''}
            onClose={() => setCheck(null)}
          />
        ) : null}
      </Dialog>
    </Stack>
  );
}

export default function Editor({
  documentId,
  canEdit,
  errorAfterMs,
}: {
  documentId: string;
  canEdit: boolean;
  errorAfterMs: number;
}) {
  // This module is loaded in the browser alone (./document-view.tsx), so the
  // page's own address is there to read.
  const [connection] = useState(
    () =>
      new DocumentConnection({
        // FR-AU-08: the application's own origin, where the browser presents the session cookie.
        url: `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}${COLLAB_PATH}`,
        documentId,
        errorAfterMs,
        probe: () =>
          fetch(`/api/documents/${documentId}`, { cache: 'no-store', credentials: 'same-origin' }).then(
            (response) => response.status,
            () => 0,
          ),
      }),
  );
  // FR-ED-15: one connection for as long as the document is open, opened when
  // the page is and closed when it goes.
  useEffect(() => {
    connection.start();
    return () => connection.stop();
  }, [connection]);

  return <OpenDocument connection={connection} canEdit={canEdit} />;
}
