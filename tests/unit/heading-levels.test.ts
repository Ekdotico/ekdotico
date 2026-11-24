// The headings of the text are drawn one level lower (ux-heading-levels): rendering alone. The stored
// heading keeps its level, what is copied carries the stored level, and what is read back is read by
// its tag or, for the element this editor draws, by its `data-level`.
import { getSchema } from '@tiptap/core';
import { DOMSerializer } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { closeSchema, extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { clipboardSerializerOf } from '../../src/app/(app)/documents/[id]/heading-levels.ts';

const schema = closeSchema(getSchema(extensions(new Y.Doc())));
const heading = (level: number) => schema.node('heading', { level }, [schema.text('Words')]);

describe('a heading of the text', () => {
  it('is drawn as h2, h3 and h4 with its stored level in data-level', () => {
    const drawn = DOMSerializer.fromSchema(schema);
    for (const level of [1, 2, 3]) {
      expect(drawn.nodes.heading!(heading(level))).toEqual([`h${level + 1}`, { 'data-level': level }, 0]);
    }
  });

  it('is put on the clipboard as the tag of its stored level, so another application is told the truth', () => {
    const copied = clipboardSerializerOf(schema);
    for (const level of [1, 2, 3]) expect(copied.nodes.heading!(heading(level))).toEqual([`h${level}`, 0]);
  });

  it('is read by its tag when it comes from elsewhere, and by data-level when this editor drew it', () => {
    const rules = schema.nodes.heading!.spec.parseDOM!;
    const tags = rules.map((rule) => rule.tag);
    expect(tags).toEqual(
      expect.arrayContaining(['h1', 'h2', 'h3', 'h2[data-level="1"]', 'h4[data-level="3"]']),
    );
    // The drawn element is tried before the plain tag, or an h2 of a Heading 1 would be a Heading 2.
    const priority = (tag: string) => rules.find((rule) => rule.tag === tag)!.priority ?? 50;
    expect(priority('h2[data-level="1"]')).toBeGreaterThan(priority('h2'));
    expect(rules.find((rule) => rule.tag === 'h2[data-level="1"]')!.attrs).toEqual({ level: 1 });
    // No rule for a fourth level: an h4 with no data-level is no heading of the text.
    expect(tags).not.toContain('h4');
  });

  it('is stored as it was: the node holds the level, never the tag', () => {
    expect(heading(2).toJSON()).toEqual({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Words' }],
    });
  });
});
