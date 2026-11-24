// The names that a screen reader hears for the controls of a code block and an image block (owner's answer of
// 24 November 2026 to ux-block-names-wording, option "with-place"). The visible words stay "Copy", "Code language"
// and "Alt text"; each name BEGINS with its visible label (WCAG 2.5.3). Nothing here is of React.

/** Where a block stands among the blocks of its own kind, in document order: the nth of m, counting from 1. */
export interface BlockPlace {
  n: number;
  m: number;
}

const placed = (place: BlockPlace) => `${place.n} of ${place.m}`;

/**
 * "Copy, Python code block 2 of 3", or "Code language, code block 2 of 3" where no language is set. `language` is the
 * display name the select shows, and null where none is set. With no place yet (the first render, before the editor
 * is known) the name is the visible label alone.
 */
export function codeBlockName(
  label: 'Copy' | 'Code language',
  language: string | null,
  place: BlockPlace | null,
): string {
  if (!place) return label;
  return `${label}, ${language ? `${language} ` : ''}code block ${placed(place)}`;
}

/** "Alt text, " and the caption where the image has one; else "Alt text, image 2 of 3". */
export function imageAltName(caption: string, place: BlockPlace | null): string {
  if (caption.trim()) return `Alt text, ${caption}`;
  return place ? `Alt text, image ${placed(place)}` : 'Alt text';
}

/** The place of the block at `pos` among those of `type`, from the positions of all of them in document order. */
export function placeAmong(positions: readonly number[], pos: number): BlockPlace | null {
  const at = positions.indexOf(pos);
  return at < 0 ? null : { n: at + 1, m: positions.length };
}
