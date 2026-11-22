import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A refusal shown in the Leave dialog must not be there the next time it opens
// (WCAG 3.3.1): Cancel and Escape both go through the one close that forgets it.
describe('the Leave document dialog', () => {
  const source = readFileSync('src/app/(app)/documents/[id]/sharing/collaborator-actions.tsx', 'utf8');
  const leave = source.slice(source.indexOf('export function LeaveDocument'));

  it('forgets a refusal when it closes', () => {
    expect(source).toMatch(/function close\(\) \{\s*setFault\(null\);\s*setOpen\(false\);\s*\}/);
  });

  it('closes by Escape and by Cancel through that function', () => {
    expect(leave).toContain('onClose={close}');
    expect(leave).toContain('id={LEAVE_CANCEL_ID} onClick={close}');
  });
});
