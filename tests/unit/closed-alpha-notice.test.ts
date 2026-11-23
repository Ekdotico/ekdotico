// FR-AU-55: the fixed text of the Closed α notice, pinned character for
// character. The text below was compared with the requirement at Docs commit
// 7887e85; a change to either side fails here, and a change to the text raises
// the version (FR-AU-56).
import { describe, expect, it } from 'vitest';
import {
  CLOSED_ALPHA_NOTICE_BODY,
  CLOSED_ALPHA_NOTICE_TITLE,
  CLOSED_ALPHA_NOTICE_VERSION,
} from '../../src/lib/closed-alpha-notice.ts';

const ALPHA = 'α';

describe('the Closed α notice (FR-AU-55)', () => {
  it('has the fixed title', () => {
    expect(CLOSED_ALPHA_NOTICE_TITLE).toBe(`Closed ${ALPHA}`);
    expect([...CLOSED_ALPHA_NOTICE_TITLE].map((character) => character.codePointAt(0))).toEqual([
      0x43, 0x6c, 0x6f, 0x73, 0x65, 0x64, 0x20, 0x3b1,
    ]);
  });

  it('has the fixed body of a release with the Feedback Widget and without a contact address', () => {
    expect(CLOSED_ALPHA_NOTICE_BODY).toBe(
      [
        `Ekdotico is in Closed ${ALPHA}.`,
        `Closed ${ALPHA} is an early test release.`,
        'Only invited people can create an account.',
        'This release does not reflect the planned first public version of Ekdotico.',
        'It may be unavailable at times, and the Ekdotico team makes no commitment about its availability.',
        'The Ekdotico team uses feedback from the people who test this release to design and develop the next steps.',
        'To send feedback, choose Send feedback at the top of any page.',
      ].join(' '),
    );
    expect(CLOSED_ALPHA_NOTICE_BODY).toHaveLength(447);
  });

  it('holds no character but the letters of the requirement: plain spaces, plain stops, and the Greek α', () => {
    expect(CLOSED_ALPHA_NOTICE_BODY).toMatch(/^[A-Za-z ,.α]+$/);
    expect(CLOSED_ALPHA_NOTICE_BODY).not.toMatch(/ {2}|^ | $/);
    expect(CLOSED_ALPHA_NOTICE_BODY.match(/α/g)).toHaveLength(2);
  });

  it('ends with the sentence on feedback, and leaves out the sentence with the contact address, which is not yet part of the text (register D111)', () => {
    expect(
      CLOSED_ALPHA_NOTICE_BODY.endsWith(' To send feedback, choose Send feedback at the top of any page.'),
    ).toBe(true);
    expect(CLOSED_ALPHA_NOTICE_BODY).not.toContain('write to');
    expect(CLOSED_ALPHA_NOTICE_BODY).not.toContain('contact');
  });

  it('is at version 2, raised when the sentence on feedback joined the text (FR-AU-56; fw-notice-version, D463)', () => {
    expect(CLOSED_ALPHA_NOTICE_VERSION).toBe(2);
  });
});
