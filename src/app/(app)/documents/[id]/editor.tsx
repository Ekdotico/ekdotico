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
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { tabbableWithin } from '@ekdotico/domico/a11y';
import { Button, Cluster, Dialog, FormFault, Stack, SyncStatus } from '@ekdotico/domico/components';
import { DocumentConnection, syncStatus, type Ending, type Held } from '../../../../lib/collab/client.ts';
import { COLLAB_PATH, LIMIT_REFUSAL, REFUSAL } from '../../../../lib/collab/protocol.ts';
import type { Limit } from '../../../../lib/collab/shape.ts';
import { PERMISSIONS_NOW } from '../../../../lib/documents/permission-texts.ts';
import { ROLE_NAME, type DocumentRole } from '../../../../lib/documents/permissions.ts';
import pageStyles from '../../../pages.module.css';
import { TABLE_PAST_BOUNDS, heldTitle, overLimits } from './block-limits.ts';
import styles from './editor.module.css';
import { BLOCK_CONTROLS, Editable, SLASH_HINT, copyText, extensions } from './extensions.tsx';
import { IMAGE_TEXT } from './images.tsx';
import { MARKDOWN_INPUT } from './input-rules.ts';
import { PeopleRow } from './people-row.tsx';
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
  // A rule of the shape of a document (register D170, D180): this editor
  // makes every block whole, so the words are for a client that does not.
  // For the owner's approval.
  [REFUSAL.INCOMPLETE]:
    'A change in this tab adds a block without the content it must hold, so it cannot be applied',
  [REFUSAL.TABLE_BOUNDS]: TABLE_PAST_BOUNDS,
  // FR-ED-08: this editor writes an image block with its four attributes under their rules, so
  // the words are for a client that does not. For the owner's approval.
  [REFUSAL.IMAGE_ATTRIBUTES]:
    'This tab tried to change an image in a way that is not allowed, so the change was not saved.',
  // FR-ED-05: the same for the marker or the entry of a footnote, which hold an identifier and nothing
  // else. For the owner's approval.
  [REFUSAL.FOOTNOTE_ATTRIBUTES]:
    'This tab tried to change a footnote in a way that is not allowed, so the change was not saved.',
  // The same for content put inside a block that holds none: an image, a divider, a table of contents, a page break.
  [REFUSAL.LEAF_CONTENT]:
    'This tab tried to put content inside a block that cannot contain any, so the change was not saved.',
  // The limits of a document (register D184, D192, D193), for the owner's approval.
  ...(Object.fromEntries(
    Object.entries(LIMIT_REFUSAL).map(([limit, reason]) => [reason, heldTitle(limit as Limit)]),
  ) as Record<(typeof LIMIT_REFUSAL)[Limit], string>),
};
// FR-ED-40 (b): the role of this connection changed and it stays open, and the
// editor "states the new role". No words are given; for the owner's approval
// (docs/plan/slice-14.md, section 6). The role's name is the one `ROLE_NAME` writes.
const ROLE_NOW = (role: DocumentRole, canEdit: boolean) =>
  `The role of this account on this document is now ${ROLE_NAME[role]}. ${
    canEdit ? 'The document can be edited in this tab.' : 'The document is read-only in this tab.'
  }`;
// F14-2: the role of this tab's connection became one that cannot edit while the tab held changes
// the server had not received. They are not taken, and the person is told (docs/plan/presence-row.md,
// section 5; for the owner's approval). It follows `ROLE_NOW`, which says the new role.
const UNSAVED =
  'Your last changes in this tab were not saved. Ekdotico did not keep them, because the role of this account changed first.';
const COPY_UNSAVED = 'Copy unsaved text';
// A repair of the document that this browser did not write (register D180,
// the browser's half). Written for the owner's approval.
const UNREPAIRED =
  'We cannot repair this document in this tab. The repair would make the document larger than our current limit of 5 MB, so the document is read-only here. Nothing in the document was changed.';
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
// How long the region of a refusal stands empty before its words are written:
// long enough for a screen reader to have seen it empty.
const HEARD_AFTER_MS = 150;
// NFR-IC-19: every control of the editor is reached by keyboard. The package
// leaves the key to the application; this is the one editors commonly use.
// Before it, the sentence that tells of the slash palette (`SLASH_HINT`): the
// shorter, and the one a writer needs first.
const KEYS =
  SLASH_HINT +
  ' Alt+F10 moves from the text to the formatting toolbar when text is selected. When no text is selected, Alt+F10 moves to the controls of the block that holds the cursor. Escape returns to the text.';

/**
 * The controls of the innermost block round the cursor that has any.
 *
 * Unless they are a menu that offers nothing where the cursor is, and a block
 * round that one has controls that do: from the caption of a table in a cell,
 * the menu of that table offers nothing, and the menu of the table round the
 * cell acts on the row and the column of the cell (R32; `TableBlockView`).
 * Where no block round the cursor offers anything, the innermost is still the
 * one, as it was: from the caption of a table that stands in no cell, the key
 * goes to that table's menu.
 */
function blockControls(view: EditorView): HTMLElement | null {
  const { node } = view.domAtPos(view.state.selection.from);
  let block = (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>(
    '[data-node-view-wrapper]',
  );
  let innermost: HTMLElement | null = null;
  while (block && view.dom.contains(block)) {
    const controls = block.querySelector<HTMLElement>(`[${BLOCK_CONTROLS}]`);
    if (controls?.closest('[data-node-view-wrapper]') === block) {
      const items = [...controls.querySelectorAll('[role="menuitem"]')];
      const offers =
        items.length === 0 || items.some((item) => item.getAttribute('aria-disabled') !== 'true');
      if (offers) return controls;
      innermost ??= controls;
    }
    block = block.parentElement?.closest<HTMLElement>('[data-node-view-wrapper]');
  }
  return innermost;
}

/** The text of the document: the editable region, and the toolbar on its selection. */
function Text({
  document,
  documentId,
  imageDays,
  awareness,
  editable,
  reads,
  onEditor,
  onUnshown,
  onUnrepairable,
}: {
  document: Y.Doc;
  /** The document, where its images are asked for (FR-ED-08). */
  documentId: string;
  /** How many days an image out of the document is kept: the words of a block whose image is gone say so (NFR-SE-18). */
  imageDays: number;
  /** Where the cursors of the others are read from (FR-ED-17); a browser that reads draws none. */
  awareness: Awareness | null;
  editable: boolean;
  /** This browser cannot edit the document, whatever the connection: it shows what the schema can show and writes nothing. */
  reads: boolean;
  /** Told that the document cannot be built here: the text goes, and the page says so. */
  onUnshown: () => void;
  /** Told that a repair was not written because it would pass 5 MB: the text is read-only (D180). */
  onUnrepairable: () => void;
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
  // The words of a change the writer asked for that was refused for the room
  // of a table, and how many times running (./extensions.tsx, `Closed`). They
  // stand until the document next changes.
  const [refusal, setRefusal] = useState<{ words: string; times: number } | null>(null);
  const refuse = useCallback(
    (words: string | null) =>
      setRefusal((was) => (words === null ? null : { words, times: (was?.times ?? 0) + 1 })),
    [],
  );
  // What an upload is doing (FR-ED-08), for the region that says so: "Uploading the image…", then "Image added".
  // A refusal of an upload is said where the refusals of the document are (`refuse`).
  const [uploading, setUploading] = useState('');
  const images = useMemo(
    () => ({ documentId, unreferencedDays: imageDays, report: refuse, announce: setUploading }),
    [documentId, imageDays, refuse],
  );
  const all = useMemo(
    () => extensions(document, onUnshown, refuse, onUnrepairable, reads, awareness, images),
    [document, onUnshown, refuse, onUnrepairable, reads, awareness, images],
  );
  // What a screen reader is given of a refusal: one region that is in the page
  // throughout, emptied and then written at each refusal, so that a second
  // refusal in the same words is heard as the first was. The design package
  // gives the reasons where it does the same (`OptionList`): a region put in
  // the page with its text in it is not certain to be spoken, and one whose
  // text does not change says nothing.
  const heard = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const region = heard.current;
    if (!region) return;
    region.textContent = '';
    if (!refusal) return;
    const timer = setTimeout(() => (region.textContent = refusal.words), HEARD_AFTER_MS);
    return () => clearTimeout(timer);
  }, [refusal]);

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
        // A browser that cannot edit is not told the keys of a writer
        // (owner's decision of 18 October 2026, D185).
        ...(reads ? {} : { 'aria-describedby': keys }),
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

  // A document past a limit already (register D184; ./block-limits.ts): it
  // can only be deleted from until it is back under, and is told so.
  // Read when the editor is told of, and at each transaction after: what the
  // binding built before then is read at once, and not missed.
  const [over, setOver] = useState('');
  useEffect(() => {
    if (!editor) return;
    const read = () => setOver(overLimits(editor.state.doc).join('\n'));
    read();
    editor.on('transaction', read);
    return () => void editor.off('transaction', read);
  }, [editor]);

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
      {reads ? null : (
        <p id={keys} className={pageStyles.meta}>
          {KEYS}
        </p>
      )}
      {/* NFR-IC-19: a change that was not made is said to be so, in words that
          are seen, here, and heard, from the region below, when the screen
          reader next falls silent. No fault of the writer's, and the focus
          stays in the text. */}
      {over && !reads ? (
        <FormFault tone="neutral" announce="polite">
          {over.split('\n').map((sentence) => (
            <p key={sentence}>{sentence}</p>
          ))}
        </FormFault>
      ) : null}
      {refusal ? (
        <FormFault tone="neutral" announce="off">
          <p>{refusal.words}</p>
        </FormFault>
      ) : null}
      <span ref={heard} role="status" className="sr-only" />
      {/* FR-ED-08: the file picker, which a person who does not drag reaches by keyboard, and what an upload is doing. */}
      {editable && !reads ? (
        <Button variant="quiet" onClick={() => editor?.commands.chooseImage()}>
          {IMAGE_TEXT.choose}
        </Button>
      ) : null}
      <p role="status" className={pageStyles.meta}>
        {uploading}
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

/**
 * F14-2: the changes this tab made that the server never took, after the role
 * of the account changed to one that cannot edit. The words in them can be
 * copied; a change that was not words (a mark, a deletion) is stated, with
 * nothing to copy. The text stays in the document of the tab as well, read-only.
 */
function Unsaved({ text }: { text: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <>
      <p>{UNSAVED}</p>
      {text ? (
        <Stack gap={3}>
          <Cluster gap={3}>
            <Button onClick={() => void copyText(text).then(setCopied)}>{COPY_UNSAVED}</Button>
          </Cluster>
          <p role="status">{copied === null ? '' : copied ? 'Text copied.' : TEXT_NOT_COPIED_HERE}</p>
        </Stack>
      ) : null}
    </>
  );
}

function OpenDocument({
  connection,
  canEdit,
  documentId,
  imageDays,
}: {
  connection: DocumentConnection;
  canEdit: boolean;
  documentId: string;
  imageDays: number;
}) {
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
  const [unrepaired, setUnrepaired] = useState(false);
  const unrepairable = useCallback(() => setUnrepaired(true), []);
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
  // FR-ED-40 (b), FR-ED-41: what the server says the connection may do, at each handshake and at each change of role; until it has said, what the page was opened with.
  const mayEdit = state.canEdit ?? canEdit;
  return (
    <Stack gap={4}>
      {/* FR-ED-17: drawn in the header of the page, beside "Sharing" (./people-row.tsx). */}
      <PeopleRow people={state.people} />
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
      {unrepaired ? (
        <FormFault tone="neutral" announce="polite">
          <p>{UNREPAIRED}</p>
        </FormFault>
      ) : null}
      {state.notice ? (
        // Neither a fault nor the error state: said again for each change of role.
        <FormFault
          key={`${state.notice.role} ${state.notice.canEdit}`}
          tone="neutral"
          announce="polite"
          autoFocus={false}
        >
          <p>{ROLE_NOW(state.notice.role, state.notice.canEdit)}</p>
          {state.unsaved ? <Unsaved text={state.unsaved.text} /> : null}
        </FormFault>
      ) : null}
      {state.permissions ? (
        // FR-ED-40 (g): "states that the permissions of the role have changed". Said again for each
        // change, and not an error: the connection is as it was.
        <FormFault key={state.permissions.changes} tone="neutral" announce="polite" autoFocus={false}>
          <p>{PERMISSIONS_NOW(ROLE_NAME[state.permissions.role])}</p>
        </FormFault>
      ) : null}
      {/* FR-ED-18: read-only in the error state, "until the connection returns". */}
      {state.opened ? (
        <Text
          // The extensions are made once for a browser that can edit, or for one that cannot.
          key={mayEdit ? 'w' : 'r'}
          document={connection.document}
          documentId={documentId}
          imageDays={imageDays}
          awareness={connection.awareness}
          editable={mayEdit && state.phase !== 'lost' && state.phase !== 'held' && !unrepaired}
          reads={!mayEdit}
          onEditor={keep}
          onUnshown={fail}
          onUnrepairable={unrepairable}
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
  imageDays,
}: {
  documentId: string;
  canEdit: boolean;
  errorAfterMs: number;
  imageDays: number;
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

  return (
    <OpenDocument connection={connection} canEdit={canEdit} documentId={documentId} imageDays={imageDays} />
  );
}
