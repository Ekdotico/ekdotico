// The name of the Insert control, pinned whole: the words the owner approved on 17 November 2026
// (ui-insert-name, "Insert a block"). A screen reader hears only this, and the tooltip shows it.
import { describe, expect, it } from 'vitest';
import { INSERT_NAME } from '../../src/app/(app)/documents/[id]/insert-name.ts';

describe('the name of the Insert control (ui-insert-name)', () => {
  it('is exactly the words the owner approved', () => {
    expect(INSERT_NAME).toBe('Insert a block');
  });
});
