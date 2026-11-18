// The image block of the editor (FR-ED-08, NFR-SE-18): its view, its controls,
// and the upload that makes one. Every control is the design package's (a
// native file input behind a command, `TextField` for the alt text and the
// caption, `Select` for the width, and the package's handle that resizes by
// dragging, `attachImageResize`, since `@ekdotico/domico` 0.32.0; register row
// S19-8). The select is the way that needs no dragging (WCAG 2.2, 2.5.7).
//
// THERE IS NO ADDRESS HERE THAT A PERSON SUPPLIED. A block holds the identifier
// of an image uploaded to this application. What the page shows is read from a
// link that the application issues for 5 minutes to someone who may read the
// document (src/lib/images/link.ts), asked for when the block comes into view and
// again when the browser cannot load the image: the link is never stored, in the
// document or anywhere, and an image that was shown stays shown.
'use client';

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Extension } from '@tiptap/core';
import { Plugin, Selection } from '@tiptap/pm/state';
import { NodeViewWrapper, type Editor, type NodeViewProps } from '@tiptap/react';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import {
  attachImageResize,
  IMAGE_RESIZE_EVENT,
  IMAGE_WIDTH_PROPERTY,
  type ImageResizeEvent,
} from '@ekdotico/domico/a11y';
import { Button, Select, TextField } from '@ekdotico/domico/components';
import { IMAGE_MESSAGES } from '../../../../lib/images/answers.ts';
import {
  IMAGE_ALT_MOST,
  IMAGE_CAPTION_MOST,
  IMAGE_MOST_BYTES,
  IMAGE_WIDTH_MOST,
} from '../../../../lib/images/node.ts';
import { BlockControls, Editable } from './block-controls.tsx';
import styles from './editor.module.css';

// ── What the page says (docs/plan/slice-19.md, section 7; for the owner's approval) ──

export const IMAGE_TEXT = {
  uploading: 'Uploading the image…',
  added: 'Image added',
  notUploaded: 'The image could not be uploaded. Check your connection and try again.',
  loading: 'Loading the image…',
  // Q14: an image that the timer has deleted; a block with no identifier, or one of another document, shows it too,
  // which is why it says what the application does and not what happened to this image.
  gone: (days: number) =>
    `This image is no longer available. An image that has been out of the document for more than ${days} ${days === 1 ? 'day' : 'days'} is deleted from storage.`,
  // The image was uploaded and the document did not take its block (it cannot be edited just now, or a limit of it is passed).
  notPlaced:
    'The image was uploaded, but it could not be put in the document just now, so it is not shown. Try again when the document can be edited.',
  notLoaded: 'The image could not be loaded. Check your connection and try again.',
  retry: 'Try again',
  altLabel: 'Alt text',
  altHint:
    'Describes the image for a person who cannot see it. Leave it empty if the image is only decoration.',
  captionLabel: 'Caption (optional)',
  widthLabel: 'Image width',
  // The name of the handle, a slider: "Resize the image", and its value is read as "50%".
  handleLabel: 'Resize the image',
  choose: 'Choose an image',
} as const;

// ── The upload ──────────────────────────────────────────────────────────────

/** What the picker offers: the four types of NFR-SE-18. The server decides all the same, from the content. */
const ACCEPT = 'image/png,image/jpeg,image/webp';

export type Uploaded = { ok: true; id: string } | { ok: false; words: string };

/**
 * Sends one file to the upload route of the document and says what came of it.
 * The route's own words are shown as they are (its statuses are the owner's
 * answer to Q8); a file over 20 MB is told so without being sent, which the
 * route would say too. The file's name is not sent, and nothing is read from it.
 */
export async function uploadImage(documentId: string, file: File): Promise<Uploaded> {
  if (file.size > IMAGE_MOST_BYTES) return { ok: false, words: IMAGE_MESSAGES.tooLarge };
  try {
    const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/images`, {
      method: 'POST',
      body: file,
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream' },
    });
    if (response.status === 201) {
      const body = (await response.json()) as { id?: unknown };
      return typeof body.id === 'string'
        ? { ok: true, id: body.id }
        : { ok: false, words: IMAGE_TEXT.notUploaded };
    }
    const body = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
    const words = body?.error?.message;
    if (typeof words === 'string') return { ok: false, words };
    // A reverse proxy that refuses a body that is too large answers in its own words, which are not ours.
    return { ok: false, words: response.status === 413 ? IMAGE_MESSAGES.tooLarge : IMAGE_TEXT.notUploaded };
  } catch {
    return { ok: false, words: IMAGE_TEXT.notUploaded };
  }
}

/**
 * Puts an image block where an upload is wanted: in place of the empty
 * paragraph the cursor is in (the one a slash command leaves), or after the
 * block it is in, at the innermost level that can hold one; and a paragraph
 * after it where nothing follows, so that the cursor has a place. `at` is a
 * position in the document, for a drop. A change that would pass a limit of the
 * document is refused by the editor as any other is, with its words.
 */
export function insertImageBlock(editor: Editor, id: string, at?: number): boolean {
  const { state } = editor;
  const image = state.schema.nodes.image;
  const paragraph = state.schema.nodes.paragraph;
  if (!image || !paragraph) return false;
  const $at = state.doc.resolve(Math.min(at ?? state.selection.from, state.doc.content.size));
  // A place between two blocks of the document, which is where a drop on a block that is no text lands.
  if ($at.depth === 0) {
    if (!state.doc.canReplaceWith($at.index(), $at.index(), image)) return false;
    const node = image.create({ id });
    const tr = state.tr.insert($at.pos, node);
    const after = $at.pos + node.nodeSize;
    if (!tr.doc.resolve(after).nodeAfter) tr.insert(after, paragraph.create());
    editor.view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(after), 1)).scrollIntoView());
    return holdsBlock(editor, id);
  }
  for (let depth = $at.depth; depth >= 1; depth -= 1) {
    const parent = $at.node(depth - 1);
    const index = $at.index(depth - 1);
    const block = $at.node(depth);
    const empty = block.type === paragraph && block.content.size === 0;
    const fits = empty
      ? parent.canReplaceWith(index, index + 1, image)
      : parent.canReplaceWith(index + 1, index + 1, image);
    if (!fits) continue;
    const from = empty ? $at.before(depth) : $at.after(depth);
    const node = image.create({ id });
    const tr = state.tr.replaceWith(from, empty ? $at.after(depth) : from, node);
    const after = from + node.nodeSize;
    if (!tr.doc.resolve(after).nodeAfter) tr.insert(after, paragraph.create());
    editor.view.dispatch(tr.setSelection(Selection.near(tr.doc.resolve(after), 1)).scrollIntoView());
    return holdsBlock(editor, id);
  }
  return false;
}

/**
 * Whether the document holds a block for this image now. `dispatch` says nothing of a change that the filters of
 * the editor refuse (the document cannot be edited just now, the connection is held, a limit of the document is
 * passed): the change is dropped, and the only way to know is to look (the review of pull request 52).
 */
function holdsBlock(editor: Editor, id: string): boolean {
  let found = false;
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image' && node.attrs.id === id) found = true;
    return !found;
  });
  return found;
}

/**
 * A place in the document that other people's changes do not move: a position of the shared document, which
 * the binding keeps, where a number would be stale once someone typed above it during an upload of 20 MB.
 * Null where the editor has no binding to the shared document.
 */
function anchorAt(editor: Editor, position: number): Y.RelativePosition | null {
  const synced = ySyncPluginKey.getState(editor.state) as
    { type?: Y.XmlFragment; binding?: { mapping: never } } | undefined;
  if (!synced?.type || !synced.binding) return null;
  try {
    return absolutePositionToRelativePosition(position, synced.type, synced.binding.mapping);
  } catch {
    return null;
  }
}

/** Where an anchor is in the document now, or null where it is nowhere (the place was deleted, or there is no binding). */
function positionOf(editor: Editor, anchor: Y.RelativePosition): number | null {
  const synced = ySyncPluginKey.getState(editor.state) as
    { doc?: Y.Doc; type?: Y.XmlFragment; binding?: { mapping: never } } | undefined;
  if (!synced?.doc || !synced.type || !synced.binding) return null;
  try {
    return relativePositionToAbsolutePosition(synced.doc, synced.type, anchor, synced.binding.mapping);
  } catch {
    return null;
  }
}

interface UploadOptions {
  /** The document the images are for; null where the page has none to give (the blocks then show no image). */
  documentId: string | null;
  /** The words of an upload that was refused, or null to clear them: the page shows them where it shows a refusal. */
  report: (words: string | null) => void;
  /** What an upload is doing, for the region that says so. */
  announce: (words: string) => void;
}

/** Uploads each file in turn and puts a block for it where it was dropped, or at the cursor. */
async function take(editor: Editor, options: UploadOptions, files: File[], at?: number) {
  const { documentId, report, announce } = options;
  if (!documentId) return;
  report(null);
  // Where it was dropped, as a place that the changes of others do not move; the second of two files follows the first.
  let anchor = at === undefined ? null : anchorAt(editor, at);
  for (const file of files) {
    announce(IMAGE_TEXT.uploading);
    const result = await uploadImage(documentId, file);
    if (editor.isDestroyed) return;
    if (!result.ok) {
      announce('');
      report(result.words);
      continue;
    }
    // Where the drop is now; where it is nowhere (its block was deleted meanwhile), the cursor.
    const place = anchor ? (positionOf(editor, anchor) ?? undefined) : undefined;
    anchor = null;
    // The block is in the document, or it is not: a change that the editor refuses is dropped without a word,
    // and "Image added" would be false. The image is uploaded all the same and counts until it is deleted.
    announce(insertImageBlock(editor, result.id, place) ? IMAGE_TEXT.added : IMAGE_TEXT.notPlaced);
  }
}

/** Opens the picker of the browser for the files wanted. A native input made for the moment, and never put in the page. */
function pick(done: (files: File[]) => void) {
  const input = globalThis.document.createElement('input');
  input.type = 'file';
  input.accept = ACCEPT;
  input.multiple = true;
  input.addEventListener('change', () => done([...(input.files ?? [])]), { once: true });
  input.click();
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    imageUpload: {
      /** Opens the file picker; the images chosen are uploaded and put where the cursor is (FR-ED-08). */
      chooseImage: () => ReturnType;
    };
  }
}

/**
 * FR-ED-08: "The image block shall accept uploads via a file picker dialog and
 * via drag-and-drop directly into the editor canvas." The command opens the
 * picker (the slash palette's "Image" and the button of the page call it), and
 * a drop of files on the text uploads them. Neither works where the document
 * cannot be edited. Nothing else makes an image block: no paste of an address
 * (src/app/(app)/documents/[id]/extensions.tsx, `ImageBlock`), no paste of a
 * file, and no address a person supplies is ever loaded.
 */
export const ImageUpload = Extension.create<UploadOptions>({
  name: 'imageUpload',
  addOptions() {
    return { documentId: null, report: () => {}, announce: () => {} };
  },
  addCommands() {
    return {
      chooseImage:
        () =>
        ({ editor }) => {
          if (!editor.isEditable || !this.options.documentId) return false;
          pick((files) => void take(editor, this.options, files));
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    return [
      new Plugin({
        props: {
          handleDrop(view, event) {
            const files = [...(event.dataTransfer?.files ?? [])];
            // A drop of text or of a block is the editor's own.
            if (files.length === 0 || !editor.isEditable || !options.documentId) return false;
            event.preventDefault();
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            void take(editor, options, files, at);
            return true;
          },
        },
      }),
    ];
  },
});

// ── The link ────────────────────────────────────────────────────────────────

type Link =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  /** The image is not there for this document: deleted, never uploaded to it, or no identifier. */
  | { status: 'gone' }
  | { status: 'failed' };

/** How often a link is asked for again where the browser cannot load the image: at most this many, a little later each time. */
const RETRIES = 3;

/**
 * The link to an image, asked of the application when the block is in view and
 * asked again where the browser reports that it could not load the image (a
 * link lives 5 minutes, and the browser may fetch an image again long after).
 * A link that was shown is kept where a later asking fails.
 */
function useImageLink(documentId: string | null, id: string | null, wanted: boolean) {
  const [asked, setLink] = useState<Link>({ status: 'idle' });
  const asking = useRef(false);
  const failures = useRef(0);
  // A block with no identifier, or in a page with no document, has nothing to ask for.
  const missing = !documentId || !id;
  const ask = useCallback(async () => {
    if (!documentId || !id || asking.current) return;
    asking.current = true;
    try {
      const response = await fetch(
        `/api/documents/${encodeURIComponent(documentId)}/images/${encodeURIComponent(id)}`,
        { credentials: 'same-origin', cache: 'no-store' },
      );
      if (response.status === 404) return setLink({ status: 'gone' });
      const body = response.status === 200 ? ((await response.json()) as { url?: unknown }) : null;
      if (typeof body?.url === 'string') setLink({ status: 'ready', url: body.url });
      else setLink((was) => (was.status === 'ready' ? was : { status: 'failed' }));
    } catch {
      setLink((was) => (was.status === 'ready' ? was : { status: 'failed' }));
    } finally {
      asking.current = false;
    }
  }, [documentId, id]);
  useEffect(() => {
    if (!wanted) return;
    // Asked from a timer, as the answer arrives: the effect itself sets nothing.
    const timer = setTimeout(() => void ask(), 0);
    return () => clearTimeout(timer);
  }, [wanted, ask]);
  /** The browser could not load the image: a new link, a little later each time, a few times. */
  const failed = useCallback(() => {
    if (failures.current >= RETRIES) return setLink({ status: 'failed' });
    failures.current += 1;
    setTimeout(() => void ask(), 1000 * failures.current);
  }, [ask]);
  const loaded = useCallback(() => {
    failures.current = 0;
  }, []);
  /** The person asked to try again. */
  const retry = useCallback(() => {
    setLink({ status: 'loading' });
    void ask();
  }, [ask]);
  const link: Link = missing ? { status: 'gone' } : asked;
  return { link, retry, failed, loaded };
}

// ── The block ───────────────────────────────────────────────────────────────

const WIDTHS = [25, 50, 75, 100];

/**
 * The image block on the design package's markup (`@ekdotico/domico` 0.32.0, "The
 * image block"): the figure, the frame that holds the picture and the handle,
 * the status that says why there is no picture, and the caption. The handle is
 * the package's `attachImageResize`: it moves the width while it is dragged and
 * writes the width to the node only when the move is done (`commit`), so that
 * a collaborator is sent one change and not one for each pixel. The `Select`
 * of widths beside the alt text and the caption is the way that needs no
 * dragging (WCAG 2.2, 2.5.7), and writes the same attribute.
 */
export function ImageBlockView({ node, editor, extension, updateAttributes }: NodeViewProps) {
  const editable = useContext(Editable);
  const { documentId, unreferencedDays } = extension.options as {
    documentId: string | null;
    unreferencedDays: number;
  };
  const id = typeof node.attrs.id === 'string' ? node.attrs.id : null;
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
  const caption = typeof node.attrs.caption === 'string' ? node.attrs.caption : '';
  const width = typeof node.attrs.width === 'number' ? node.attrs.width : IMAGE_WIDTH_MOST;

  // The link is asked for when the block is near the screen: a document of many images does not ask for all of them at once.
  const frame = useRef<HTMLDivElement>(null);
  // Where the browser cannot tell, it is near.
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const element = frame.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { link, retry, failed, loaded } = useImageLink(documentId, id, near);
  const shown = link.status === 'ready';

  // The handle: only for someone who can change the document, and only where there is a picture to resize.
  const handle = useRef<HTMLDivElement>(null);
  const resizing = useRef<{ update(width: number): void; destroy(): void } | null>(null);
  const attributes = useRef(updateAttributes);
  useEffect(() => {
    attributes.current = updateAttributes;
  });
  const widthNow = useRef(width);
  useEffect(() => {
    widthNow.current = width;
  });
  const hasHandle = editable && shown;
  useEffect(() => {
    const grip = handle.current;
    const box = frame.current;
    if (!hasHandle || !grip || !box) return;
    const resize = attachImageResize({ handle: grip, frame: box, width: widthNow.current });
    resizing.current = resize;
    // Only the end of a move is written (phase `commit`): the width is shown while it is dragged and not decided.
    const done = (event: Event) => {
      const { width: chosen, phase } = (event as ImageResizeEvent).detail;
      if (phase === 'commit') attributes.current({ width: chosen });
    };
    grip.addEventListener(IMAGE_RESIZE_EVENT, done);
    return () => {
      grip.removeEventListener(IMAGE_RESIZE_EVENT, done);
      resize.destroy();
      resizing.current = null;
    };
  }, [hasHandle]);
  // The width of the node, from the select or from another collaborator: the frame follows it.
  useEffect(() => {
    if (resizing.current) resizing.current.update(width);
    else frame.current?.style.setProperty(IMAGE_WIDTH_PROPERTY, `${width}%`);
  }, [width, hasHandle]);

  const widths = [...new Set([...WIDTHS, width])].sort((a, b) => a - b);
  // The package draws two states of a block with no picture: on its way, and not coming. Asking for the link is the first.
  const state = shown
    ? undefined
    : link.status === 'gone' || link.status === 'failed'
      ? 'unavailable'
      : 'uploading';
  const words =
    link.status === 'gone'
      ? IMAGE_TEXT.gone(unreferencedDays)
      : link.status === 'failed'
        ? IMAGE_TEXT.notLoaded
        : shown
          ? ''
          : IMAGE_TEXT.loading;
  return (
    <NodeViewWrapper as="figure" className="ekd-image" data-state={state} data-image-id={id ?? undefined}>
      {editable ? (
        <BlockControls editor={editor} className={styles.controls}>
          <TextField
            label={IMAGE_TEXT.altLabel}
            hint={IMAGE_TEXT.altHint}
            value={alt}
            maxLength={IMAGE_ALT_MOST}
            onChange={(event) => updateAttributes({ alt: event.target.value })}
          />
          <TextField
            label={IMAGE_TEXT.captionLabel}
            value={caption}
            maxLength={IMAGE_CAPTION_MOST}
            onChange={(event) => updateAttributes({ caption: event.target.value })}
          />
          <Select
            label={IMAGE_TEXT.widthLabel}
            size="small"
            value={String(width)}
            onChange={(event) => updateAttributes({ width: Number(event.target.value) })}
          >
            {widths.map((each) => (
              <option key={each} value={String(each)}>
                {each}%
              </option>
            ))}
          </Select>
        </BlockControls>
      ) : null}
      <div
        ref={frame}
        className="ekd-image-frame"
        contentEditable={false}
        aria-busy={state === 'uploading' || undefined}
      >
        {shown ? (
          // The link is the application's, and the policy of a page admits no other origin than its own and the store's.
          // eslint-disable-next-line @next/next/no-img-element -- a link of 5 minutes to a private object, which the image pipeline of Next.js would fetch and keep
          <img
            className="ekd-image-img"
            src={link.url}
            alt={alt}
            draggable={false}
            referrerPolicy="no-referrer"
            onLoad={loaded}
            onError={failed}
          />
        ) : null}
        {/* In the page before its words change, so that a screen reader says them (the package's README). */}
        <p className="ekd-image-status" role="status">
          {words}
        </p>
        {/* After the live region and not in it: what is said when the words change is the words alone. */}
        {link.status === 'failed' ? (
          <Button variant="quiet" onClick={retry}>
            {IMAGE_TEXT.retry}
          </Button>
        ) : null}
        {hasHandle ? (
          <div ref={handle} className="ekd-image-resize" aria-label={IMAGE_TEXT.handleLabel} />
        ) : null}
      </div>
      {caption ? <figcaption className="ekd-image-caption">{caption}</figcaption> : null}
    </NodeViewWrapper>
  );
}
