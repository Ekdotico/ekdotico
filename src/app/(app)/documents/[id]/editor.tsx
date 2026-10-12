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
import { DocumentConnection, syncStatus, type Ending, type Held } from '../../../../lib/collab/client.ts';
import { COLLAB_PATH, REFUSAL } from '../../../../lib/collab/protocol.ts';
import pageStyles from '../../../pages.module.css';
import styles from './editor.module.css';
import { BLOCK_CONTROLS, Editable, SLASH_HINT, copyText, extensions } from './extensions.tsx';
import { MARKDOWN_INPUT } from './input-rules.ts';
import { SelectionToolbar } from './selection-toolbar.tsx';
import { SlashPaletteList } from './slash-palette.tsx';

// The fixed texts, word for word.
const IN_SYNC = 'Document autosaves — working version is in sync.'; // FR-ED-24
const AT_CAPACITY =
  'This document has reached its limit of ten connections. Ekdotico tries again every 30 seconds.'; // FR-ED-18

// The requirements give no words for what follows. Written under the
// Expression Guidelines; the owner approves them with the pull request (the
// answer to Q6 of the plan).
const DISCARDED = 'Ekdotico discarded the changes that it had not yet sent.';
const TEXT_NOT_COPIED =
  'The text could not be copied. The browser may have refused access to the clipboard. Close this dialog, select the text in the document, and copy it with the keyboard before reloading.';
const ENDED: Record<Ending, { title: string; text: string; href: string; link: string }> = {
  // FR-ED-41: "a neutral statement that the user's access to the document has ended".
  [REFUSAL.ACCESS_ENDED]: {
    title: 'Access to this document has ended',
    text: `Ekdotico closed the document in this tab. ${DISCARDED}`,
    href: '/',
    link: 'Documents',
  },
  // A person followed an address here, so the title names it; the 404 of a
  // document's routes answers the actions of a list and names none
  // (src/lib/documents/access.ts).
  [REFUSAL.NO_ACCESS]: {
    title: 'No document was found at this address for this account',
    text: 'Check the address.',
    href: '/',
    link: 'Documents',
  },
  [REFUSAL.SESSION_ENDED]: {
    title: 'The session has ended',
    text: `Ekdotico closed the document in this tab. ${DISCARDED}`,
    // `SIGN_IN_PATH` of src/proxy.ts, which is a module of the server.
    href: '/sign-in',
    link: 'Sign in again',
  },
};
// A change that the server refused for a limit of the document (the owner's
// decision of 12 October 2026; src/lib/collab/protocol.ts). The numbers are
// those of src/lib/collab/state.ts, a module of the server:
// tests/unit/editor.test.ts holds the two together. The third names no number:
// the limit is on how much a change may refer to content the document does not
// hold, which means nothing to a writer. Written under the Expression
// Guidelines, for the owner's approval.
const HELD: Record<Held, string> = {
  [REFUSAL.TOO_LARGE]: 'A change in this tab would make the document larger than 5 MB',
  [REFUSAL.TOO_DEEP]: 'A change in this tab would nest the content more than 50 levels deep',
  [REFUSAL.TOO_DANGLING]:
    'A change in this tab refers to content that this document does not hold, so it cannot be applied',
};
const HELD_TEXT =
  'The server did not take the change, and the document is read-only in this tab. The changes that were not sent are shown here and nowhere else. Copy the text to keep it, then reload the document from the server. Reloading discards the changes that were not sent.';
// `TEXT_NOT_COPIED`, where there is no dialog to close.
const TEXT_NOT_COPIED_HERE =
  'The text could not be copied. The browser may have refused access to the clipboard. Select the text in the document, and copy it with the keyboard before reloading.';
// A document that this browser cannot build (./extensions.tsx, `holdBinding`).
// Said as what it is, and not as a fault of the server: nothing was sent.
const UNSHOWN = {
  title: 'This document could not be shown',
  text: 'Ekdotico could not build the content of the document in this browser, so the document is closed in this tab. Nothing in the document was changed.',
  href: '/',
  link: 'Documents',
};
// NFR-IC-19: every control of the editor is reached by keyboard. The package
// leaves the key to the application; this is the one editors commonly use.
// Before it, the sentence that tells of the slash palette (`SLASH_HINT`): the
// shorter, and the one a writer needs first.
const KEYS =
  SLASH_HINT +
  ' Alt+F10 moves from the text to the formatting toolbar when text is selected. When no text is selected, Alt+F10 moves to the controls of the block that holds the cursor. Escape returns to the text.';

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
  onUnshown,
}: {
  document: Y.Doc;
  editable: boolean;
  /** Told that the document cannot be built here: the text goes, and the page says so. */
  onUnshown: () => void;
  /** Told of the editor, for the one who copies its text (FR-ED-24). */
  onEditor: (editor: TextEditor | null) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const keys = useId();
  // What the region says of itself, which follows `editable` (below).
  const readOnly = useRef(!editable);
  // Whether the focus was last in the surface: the text, the toolbar, a
  // block's controls, the dialog of a link.
  const within = useRef(false);
  const all = useMemo(() => extensions(document, onUnshown), [document, onUnshown]);

  const editor = useEditor({
    extensions: all,
    editable,
    // The library writes a `<style>` element, which the policy of the page
    // admits by the nonce of the document that is loaded (src/lib/csp.ts). It
    // is read from a script of that document, which is where a script may: a
    // page reached without a load is rendered for another request, and the
    // nonce of that one opens nothing here.
    injectNonce: globalThis.document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce,
    // Rendered in the browser alone: the server has no document to render.
    immediatelyRender: false,
    // FR-ED-14: the rules of ./input-rules.ts and of no other extension. The
    // library's own set is not that list, and nothing pasted is converted.
    enableInputRules: [MARKDOWN_INPUT],
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
  // connection returns. The focus stays in the text: a region that stops being
  // editable would otherwise drop it, and so would the toolbar, the controls
  // of a block and the dialog of a link, which go when the editing does.
  useEffect(() => {
    if (!editor || editor.isEditable === editable) return;
    const page = editor.view.dom.ownerDocument;
    const active = page.activeElement;
    const held = within.current && (active === page.body || surface.current?.contains(active));
    readOnly.current = !editable;
    editor.setEditable(editable);
    if (held) editor.view.dom.focus({ preventScroll: true });
  }, [editor, editable]);

  return (
    <Editable.Provider value={editable}>
      <p id={keys} className={pageStyles.meta}>
        {KEYS}
      </p>
      <div
        ref={surface}
        className={styles.surface}
        onFocus={() => (within.current = true)}
        onBlur={(event) => {
          // To somewhere else on the page. A control that is removed while it
          // has the focus names no such place, and the focus is still the surface's.
          if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
            within.current = false;
          }
        }}
      >
        {editor ? <SelectionToolbar editor={editor} surface={surface} rowRef={row} /> : null}
        <EditorContent editor={editor} />
        {editor ? <SlashPaletteList editor={editor} /> : null}
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
  // Whether the last press of "Copy text" copied it. A refusal is never left
  // unsaid: the reader was just told to copy before reloading.
  const [copied, setCopied] = useState<boolean | null>(null);
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
        <Button onClick={() => void copyText(text()).then(setCopied)}>Copy text</Button>
        <Button variant="destructive" onClick={() => window.location.reload()}>
          Reload document
        </Button>
        <Button onClick={onClose}>Close</Button>
      </Cluster>
      <p role="status">{copied === null ? '' : copied ? 'Text copied.' : TEXT_NOT_COPIED}</p>
    </Stack>
  );
}

/**
 * What is said where the server refused a change of this tab for a limit:
 * which limit, and the two things there are to do, as the dialog of the sync
 * status offers them. Focus stays in the text, which is still there to select.
 */
function HeldChange({ held, text }: { held: Held; text: () => string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <FormFault title={HELD[held]} autoFocus={false}>
      <Stack gap={4}>
        <p>{HELD_TEXT}</p>
        <Cluster gap={3}>
          <Button onClick={() => void copyText(text()).then(setCopied)}>Copy text</Button>
          <Button variant="destructive" onClick={() => window.location.reload()}>
            Reload document
          </Button>
        </Cluster>
        <p role="status">{copied === null ? '' : copied ? 'Text copied.' : TEXT_NOT_COPIED_HERE}</p>
      </Stack>
    </FormFault>
  );
}

function OpenDocument({ connection, canEdit }: { connection: DocumentConnection; canEdit: boolean }) {
  const state = useSyncExternalStore(connection.subscribe, connection.getState, connection.getState);
  const [check, setCheck] = useState<'checking' | 'in-sync' | 'unconfirmed' | null>(null);
  // Which check the dialog is showing. An answer to a check whose dialog was
  // closed, or that another check replaced, opens nothing and takes no focus.
  const asked = useRef(0);
  const close = () => {
    asked.current += 1;
    setCheck(null);
  };
  const editor = useRef<TextEditor | null>(null);
  const [unshown, setUnshown] = useState(false);
  const fail = useCallback(() => setUnshown(true), []);
  const keep = useCallback((made: TextEditor | null) => {
    editor.current = made;
  }, []);

  if (state.phase === 'ended' && state.ending) {
    const { title, text, href, link } = ENDED[state.ending];
    // No fault, and not the error state (FR-ED-41). The text and the control
    // that had the focus are gone, so the statement takes it.
    return (
      <FormFault tone="neutral" announce="polite" autoFocus title={title}>
        <p>{text}</p>
        <p>
          <Link href={href}>{link}</Link>
        </p>
      </FormFault>
    );
  }

  if (unshown) {
    const { title, text, href, link } = UNSHOWN;
    // The text and whatever had the focus are gone, so the statement takes it.
    return (
      <FormFault autoFocus title={title}>
        <p>{text}</p>
        <p>
          <Link href={href}>{link}</Link>
        </p>
      </FormFault>
    );
  }

  const status = syncStatus(state);
  return (
    <Stack gap={4}>
      {state.phase === 'held' && state.held ? (
        <HeldChange held={state.held} text={() => editor.current?.getText() ?? ''} />
      ) : state.phase === 'capacity' ? (
        // FR-ED-18: "neither the reconnecting state nor the error state".
        <FormFault tone="neutral" announce="polite">
          <p>{AT_CAPACITY}</p>
        </FormFault>
      ) : (
        <SyncStatus
          state={status.state}
          label={status.label}
          onClick={() => {
            const mine = (asked.current += 1);
            setCheck('checking');
            void connection.verify().then((same) => {
              if (asked.current === mine) setCheck(same ? 'in-sync' : 'unconfirmed');
            });
          }}
        />
      )}
      {/* FR-ED-18: read-only in the error state, "until the connection returns". */}
      {state.opened ? (
        <Text
          document={connection.document}
          editable={canEdit && state.phase !== 'lost' && state.phase !== 'held'}
          onEditor={keep}
          onUnshown={fail}
        />
      ) : null}
      <Dialog open={check !== null} onClose={close} title="Sync status">
        {check ? (
          <SyncCheck
            result={check}
            // The text as the blocks hold it, a blank line between two.
            text={() => editor.current?.getText() ?? ''}
            onClose={close}
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
