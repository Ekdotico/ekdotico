// F10: what a person who can only read a document is told, pinned whole for each role it can name.
import { describe, expect, it } from 'vitest';
import { readerLine } from '../../src/app/(app)/documents/[id]/reader-line.ts';

describe('the line a reader is shown in place of the hint (F10; ui-t3-reader)', () => {
  it.each([
    ['owner', 'You can read this document. Your role on it is Owner.'],
    ['editor', 'You can read this document. Your role on it is Editor.'],
    ['reviewer', 'You can read this document. Your role on it is Reviewer.'],
    ['viewer', 'You can read this document. Your role on it is Viewer.'],
  ] as const)('says, for the %s, exactly the approved words', (role, words) => {
    expect(readerLine(role)).toBe(words);
  });
});
