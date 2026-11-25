// The toolbar on the selection, for the nine marks of FR-ED-02 (the owner's
// decision E3 of 8 October 2026). Every control is the design package's; what
// the package leaves to the application is here: where the toolbar is placed,
// when it is shown (once the person stops selecting: at the release of the
// pointer, or at once for the keyboard), the key that reaches it and the key
// that leaves it
// (`@ekdotico/domico`, "The toolbar and the toggle button").
'use client';

import { useContext, useEffect, useLayoutEffect, useState } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import {
  Button,
  Cluster,
  Dialog,
  FormFault,
  Stack,
  TextField,
  ToggleButton,
  Toolbar,
  Tooltip,
} from '@ekdotico/domico/components';
import {
  BoldIcon,
  CodeIcon,
  HighlighterIcon,
  ItalicIcon,
  LinkIcon,
  StrikethroughIcon,
  SubscriptIcon,
  SuperscriptIcon,
  UnderlineIcon,
} from '@ekdotico/domico/icons';
import { linkAddress } from '../../../../lib/editor/link.ts';
import { toolbarSide } from '../../../../lib/editor/toolbar-side.ts';
import styles from './editor.module.css';
import { Editable } from './extensions.tsx';
import { EDIT_LINK } from './shortcuts.ts';

// FR-ED-02, in its order: the name of each mark in the schema, the name of its
// control, and its icon. The hyperlink is the eighth and has its own control.
const MARKS = [
  ['bold', 'Bold', BoldIcon],
  ['italic', 'Italic', ItalicIcon],
  ['underline', 'Underline', UnderlineIcon],
  ['strike', 'Strikethrough', StrikethroughIcon],
  ['code', 'Inline code', CodeIcon],
  ['superscript', 'Superscript', SuperscriptIcon],
  ['subscript', 'Subscript', SubscriptIcon],
  ['link', 'Link', LinkIcon],
  ['highlight', 'Highlight', HighlighterIcon],
] as const;

const ADDRESS_ID = 'link-address';
const ADDRESS_HINT = 'An address that begins with https://, http://, or mailto:';
const ADDRESS_RULE =
  'Enter an address that begins with https://, http://, or mailto: — for example, https://example.org.';

/** The address of the link: set, changed, or removed. A text field stands beside a toolbar and never in one. */
function LinkForm({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const current: unknown = editor.getAttributes('link').href;
  const [refused, setRefused] = useState(0);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // What a person typed, without the space round it: the rule itself mends nothing.
    const typed = new FormData(event.currentTarget).get('address');
    const href = linkAddress(typeof typed === 'string' ? typed.trim() : typed);
    if (!href) return setRefused((count) => count + 1);
    editor.chain().extendMarkRange('link').setLink({ href }).run();
    onDone();
  }

  return (
    <form method="post" noValidate onSubmit={submit}>
      <Stack gap={5}>
        {refused > 0 ? (
          <FormFault
            title="The link was not saved, because its address does not meet the rule."
            headingLevel={3}
            faults={[{ fieldId: ADDRESS_ID, message: ADDRESS_RULE }]}
            focusKey={refused}
          />
        ) : null}
        <TextField
          id={ADDRESS_ID}
          name="address"
          label="Link address"
          hint={ADDRESS_HINT}
          defaultValue={typeof current === 'string' ? current : ''}
          inputMode="url"
          autoComplete="off"
          error={refused > 0 ? ADDRESS_RULE : undefined}
        />
        <Cluster gap={3}>
          <Button variant="primary" type="submit">
            Save
          </Button>
          {typeof current === 'string' ? (
            <Button
              onClick={() => {
                editor.chain().extendMarkRange('link').unsetLink().run();
                onDone();
              }}
            >
              Remove link
            </Button>
          ) : null}
          <Button onClick={onDone}>Cancel</Button>
        </Cluster>
      </Stack>
    </form>
  );
}

/**
 * Shown when text is selected in a document that can be edited, and the focus
 * is in the text, in the toolbar, or in the dialog of a link. It opens when the
 * selecting ends: a selection made with the keyboard opens it at once, and one
 * made with the pointer (a drag, a double or a triple click) opens it when the
 * button is released, wherever that is; while the button is held it is hidden.
 * `surface` is the positioned element the editor stands in.
 *
 * The toolbar never takes the focus by itself, so the selection is not lost
 * when it appears: a pointer press on a control is kept from moving the focus,
 * and the keyboard reaches the row with Alt+F10 (./editor.tsx) and returns
 * with Escape.
 */
export function SelectionToolbar({
  editor,
  surface,
  rowRef,
}: {
  editor: Editor;
  surface: React.RefObject<HTMLDivElement | null>;
  /** The element that holds the toolbar, for the key that moves the focus to it. */
  rowRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [inText, setInText] = useState(editor.isFocused);
  const [inRow, setInRow] = useState(false);
  const [link, setLink] = useState(0);
  const [linking, setLinking] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number; below: boolean } | null>(null);
  // FR-ED-18: the dialog of a link does not outlast the editing it belongs to.
  // Its command would change nothing (`mayApply`), so it is closed, and the
  // text takes the focus (./editor.tsx).
  const editable = useContext(Editable);
  if (!editable && linking) setLinking(false);

  const selection = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { from, to, empty } = current.state.selection;
      // A mark is of text: not of a block selected whole, and not of code.
      const marks = current.isEditable && !empty && current.can().toggleMark('bold');
      return {
        from,
        to,
        shown: marks && !current.isActive('codeBlock') && !current.isActive('tableCaption'),
        active: MARKS.map(([name]) => current.isActive(name)),
      };
    },
  });

  useEffect(() => {
    const focus = () => setInText(true);
    // Not on the way into the toolbar, whose controls would go with it.
    const blur = ({ event }: { event: FocusEvent }) => {
      if (!rowRef.current?.contains(event.relatedTarget as globalThis.Node | null)) setInText(false);
    };
    editor.on('focus', focus);
    editor.on('blur', blur);
    return () => {
      editor.off('focus', focus);
      editor.off('blur', blur);
    };
  }, [editor, rowRef]);

  // Not while a selection is made with the pointer: the toolbar waits for the
  // release, wherever it is, and then stands over the selection as it ends.
  // A press on the toolbar or in the dialog of a link is not in the text, and
  // changes nothing.
  const [selecting, setSelecting] = useState(false);
  useEffect(() => {
    const text = editor.view.dom;
    const press = (event: PointerEvent) => {
      if (event.button === 0) setSelecting(true);
    };
    const release = () => setSelecting(false);
    text.addEventListener('pointerdown', press);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      text.removeEventListener('pointerdown', press);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [editor]);

  // FR-ED-13: Ctrl or Cmd, and K, pressed in the text, opens the same dialog (./shortcuts.ts).
  useEffect(() => {
    const within = surface.current;
    const edit = () => {
      setLink((count) => count + 1);
      setLinking(true);
    };
    within?.addEventListener(EDIT_LINK, edit);
    return () => within?.removeEventListener(EDIT_LINK, edit);
  }, [surface]);

  const shown = editable && selection.shown && !selecting && (inText || inRow || linking);

  // Above the start of the selection, and inside the surface at any width.
  useLayoutEffect(() => {
    if (!shown) return;
    const put = () => {
      if (!surface.current || !rowRef.current) return;
      const start = editor.view.coordsAtPos(selection.from);
      const box = surface.current.getBoundingClientRect();
      const room = box.width - rowRef.current.offsetWidth;
      const left = Math.max(0, Math.min(start.left - box.left, room));
      // The gap is the row's own margin below (editor.module.css), so the one value serves both sides.
      const gap = parseFloat(getComputedStyle(rowRef.current).marginBlockEnd) || 0;
      const side = toolbarSide(start.top - box.top, rowRef.current.offsetHeight, gap);
      // Below, it stands under the line the selection starts on.
      setPlace({
        top: (side === 'above' ? start.top : start.bottom) - box.top,
        left,
        below: side === 'below',
      });
    };
    put();
    // The text wraps anew at another width, and the selection moves with it.
    window.addEventListener('resize', put);
    return () => window.removeEventListener('resize', put);
  }, [shown, selection.from, selection.to, editor, surface, rowRef]);

  return (
    <>
      {shown ? (
        <div
          ref={rowRef}
          className={place?.below ? `${styles.toolbar} ${styles.toolbarBelow}` : styles.toolbar}
          style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
          onFocus={() => setInRow(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setInRow(false);
          }}
          onKeyDown={(event) => {
            // Not the Escape that only dismissed a tooltip of the row.
            if (event.key === 'Escape' && !event.defaultPrevented) editor.commands.focus();
          }}
        >
          <Toolbar label="Formatting" floating>
            {MARKS.map(([name, label, Icon], index) => (
              // Above the selection the row stands under "Choose an image" and the hint, so its tooltips
              // open downwards and cover the selection, not them (live walk W-2).
              <Tooltip key={name} content={label} placement={place?.below ? 'top' : 'bottom'}>
                <ToggleButton
                  label={label}
                  pressed={selection.active[index]!}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (name === 'link') {
                      setLink((count) => count + 1);
                      setLinking(true);
                    } else {
                      editor.chain().toggleMark(name).run();
                    }
                  }}
                >
                  <Icon />
                </ToggleButton>
              </Tooltip>
            ))}
          </Toolbar>
        </div>
      ) : null}
      <Dialog open={linking} onClose={() => setLinking(false)} title="Link">
        {linking ? <LinkForm key={link} editor={editor} onDone={() => setLinking(false)} /> : null}
      </Dialog>
    </>
  );
}
