import { describe, expect, it } from 'vitest';
import { closedText } from '../../src/app/(app)/documents/[id]/ended-text.ts';

describe('the statement of a document that closed', () => {
  it('says the changes were discarded only when some were unsent', () => {
    expect(closedText(true)).toBe(
      'Ekdotico closed the document in this tab. Ekdotico discarded the changes that it had not yet sent.',
    );
    expect(closedText(false)).toBe('Ekdotico closed the document in this tab.');
    expect(closedText(undefined)).toBe('Ekdotico closed the document in this tab.');
  });
});
