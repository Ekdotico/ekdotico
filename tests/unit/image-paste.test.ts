// A paste of files goes the way of the picker and of a drop (FR-ED-08, NFR-SE-18): through `take`, with the same
// limit, refusals and words, at the cursor; and a paste that holds text is the editor's own, so nothing is inserted
// twice and HTML that refers to an image at another address is inserted without it (NFR-SE-06). Security-sensitive:
// each case fails when its rule is broken.
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { IMAGE_TEXT, pastedFiles } from '../../src/app/(app)/documents/[id]/images.tsx';
import { IMAGE_MESSAGES } from '../../src/lib/images/answers.ts';
import { IMAGE_MOST_BYTES } from '../../src/lib/images/node.ts';

const ID = 'cabcdefghijklmnopqrstuvwx';

function clipboard(files: File[], text: Record<string, string> = {}) {
  return {
    items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    getData: (type: string) => text[type] ?? '',
  } as unknown as DataTransfer;
}

function setup(options: { editable?: boolean; documentId?: string | null } = {}) {
  const said: (string | null)[] = [];
  const announced: string[] = [];
  const editor = new Editor({
    element: null,
    editable: options.editable ?? true,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    extensions: extensions(new Y.Doc(), undefined, undefined, undefined, false, null, {
      documentId: (options.documentId === undefined ? 'd' : options.documentId) as string,
      unreferencedDays: 30,
      report: (words: string | null) => said.push(words),
      announce: (words: string) => announced.push(words),
    }),
  });
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  editor.commands.setTextSelection(1);
  // With no element the view has no document view, which the editor reads as destroyed; `take` stops there.
  Object.defineProperty(editor, 'isDestroyed', { get: () => false });
  const paste = (data: DataTransfer | null) => {
    const event = { clipboardData: data, preventDefault: vi.fn() } as unknown as ClipboardEvent;
    const handled = editor.state.plugins.some(
      (plugin) => plugin.props.handlePaste?.call(plugin, editor.view, event, null as never) === true,
    );
    return { handled, prevented: (event.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length > 0 };
  };
  const ids = () => {
    const found: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'image') found.push(String(node.attrs.id));
    });
    return found;
  };
  return { editor, paste, ids, said, announced };
}

const png = (name = 'a.png') => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

afterEach(() => vi.unstubAllGlobals());

describe('pastedFiles', () => {
  it('takes file items, and only where the clipboard holds no text', () => {
    const file = png();
    expect(pastedFiles(clipboard([file]))).toEqual([file]);
    expect(
      pastedFiles(
        clipboard([file], { 'text/html': '<meta charset=\'utf-8\'><img src="https://example.com/x.png">' }),
      ),
    ).toEqual([file]);
    expect(pastedFiles(clipboard([file], { 'text/plain': 'words' }))).toEqual([]);
    expect(
      pastedFiles(clipboard([file], { 'text/html': '<p>words</p><img src="https://example.com/x.png">' })),
    ).toEqual([]);
  });

  it('takes a lone picture from an office application: a style block and comments are not words', () => {
    const file = png();
    const html =
      '<html><head><style>p { margin: 0 }</style></head><body><!--[if mso]><p>x</p><![endif]--><script>1</script><img src="file:///x.png"></body></html>';
    expect(pastedFiles(clipboard([file], { 'text/html': html }))).toEqual([file]);
  });

  it('skips a string item and a file item that gives no file, and throws nothing', () => {
    const file = png();
    const data = {
      items: [
        { kind: 'string', type: 'text/plain', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => null },
        { kind: 'file', type: 'image/png', getAsFile: () => file },
      ],
      getData: () => '',
    } as unknown as DataTransfer;
    expect(pastedFiles(data)).toEqual([file]);
    expect(
      pastedFiles({
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => null }],
        getData: () => '',
      } as unknown as DataTransfer),
    ).toEqual([]);
  });

  it('takes nothing from a clipboard with no file item, or none at all', () => {
    expect(pastedFiles(clipboard([], { 'text/plain': 'words' }))).toEqual([]);
    expect(pastedFiles(null)).toEqual([]);
  });
});

describe('a paste of a picture', () => {
  it('uploads once, with the picker’s route and type, and puts the block at the cursor with the same words', async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ id: ID }), { status: 201 }));
    vi.stubGlobal('fetch', fetched);
    const { paste, ids, announced } = setup();
    const result = paste(clipboard([png()]));
    expect(result).toEqual({ handled: true, prevented: true });
    await settle();
    expect(fetched).toHaveBeenCalledTimes(1);
    const [url, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/documents/d/images');
    expect((init.headers as Record<string, string>)['content-type']).toBe('image/png');
    expect(ids()).toEqual([ID]);
    expect(announced).toEqual([IMAGE_TEXT.uploading, IMAGE_TEXT.added]);
  });

  it('sends the file itself as the body, with its own type, and only its image lands, none from an address', async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ id: ID }), { status: 201 }));
    vi.stubGlobal('fetch', fetched);
    const { paste, ids } = setup();
    const file = png();
    const html = '<meta charset="utf-8"><img src="https://example.com/pixel.png">';
    expect(paste(clipboard([file], { 'text/html': html })).handled).toBe(true);
    await settle();
    const [, init] = fetched.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe(file);
    expect((init.body as File).size).toBe(3);
    expect((init.headers as Record<string, string>)['content-type']).toBe(file.type);
    expect(ids()).toEqual([ID]);
  });

  it('uploads one for each file, in turn', async () => {
    const fetched = vi.fn(async () => new Response(JSON.stringify({ id: ID }), { status: 201 }));
    vi.stubGlobal('fetch', fetched);
    const { paste } = setup();
    paste(clipboard([png('a.png'), png('b.png')]));
    await settle();
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('sends a file over 20 MB nowhere and says the limit in the same words', async () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const { paste, said, ids } = setup();
    const big = new File([], 'big.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: IMAGE_MOST_BYTES + 1 });
    paste(clipboard([big]));
    await settle();
    expect(fetched).not.toHaveBeenCalled();
    expect(said).toEqual([null, IMAGE_MESSAGES.tooLarge]);
    expect(ids()).toEqual([]);
  });

  it('refuses a file of another type, a GIF among them, with the route’s words and inserts nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ error: { message: IMAGE_MESSAGES.gif } }), { status: 415 }),
      ),
    );
    const { paste, said, ids } = setup();
    expect(paste(clipboard([new File([new Uint8Array([1])], 'a.gif', { type: 'image/gif' })])).handled).toBe(
      true,
    );
    await settle();
    expect(said).toEqual([null, IMAGE_MESSAGES.gif]);
    expect(ids()).toEqual([]);
  });

  it('says the upload failed in the usual words where the connection fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('offline'))),
    );
    const { paste, said } = setup();
    paste(clipboard([png()]));
    await settle();
    expect(said).toEqual([null, IMAGE_TEXT.notUploaded]);
  });
});

describe('a paste that is not for the upload', () => {
  it('leaves a paste of text to the editor and uploads nothing', () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const { paste } = setup();
    expect(paste(clipboard([], { 'text/plain': 'words' }))).toEqual({ handled: false, prevented: false });
    expect(fetched).not.toHaveBeenCalled();
  });

  it('leaves HTML with words and a picture to the editor: no double insert, no image from the address', () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const { paste, ids } = setup();
    const html = '<p>words</p><img src="https://example.com/pixel.png">';
    expect(paste(clipboard([png()], { 'text/html': html }))).toEqual({ handled: false, prevented: false });
    expect(fetched).not.toHaveBeenCalled();
    expect(ids()).toEqual([]);
  });

  it('is not active where the document cannot be edited', () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const { paste } = setup({ editable: false });
    expect(paste(clipboard([png()]))).toEqual({ handled: false, prevented: false });
    expect(fetched).not.toHaveBeenCalled();
  });

  it('is not active where the page has no document', () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    const { paste } = setup({ documentId: null });
    expect(paste(clipboard([png()]))).toEqual({ handled: false, prevented: false });
    expect(fetched).not.toHaveBeenCalled();
  });
});
