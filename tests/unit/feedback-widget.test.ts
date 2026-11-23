import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkInput,
  clockTime,
  countText,
  countOf,
  NOTICE,
  outcomeOf,
  PRIVACY_HREF,
  rateLimitedText,
  remainingOf,
  retryId,
  routePattern,
  tooLongText,
  WIDGET_TEXT,
} from '../../src/lib/feedback/widget.ts';

// The Feedback Widget's screen (FR-AU-59 to FR-AU-80; fw-strings, fw-refused-text, fw-retry-id, fw-retry-edit).
// The behaviour of the dialog in a browser is in tests/e2e/feedback-widget.spec.ts. What no test here covers:
// a real screen reader, and a layout at 320 CSS pixels or 400 per cent zoom.

describe('the approved texts, each pinned whole', () => {
  it('has the fixed labels, kinds and sentences', () => {
    expect(WIDGET_TEXT).toEqual({
      control: 'Send feedback',
      title: 'Send feedback',
      close: 'Close',
      legend: 'Kind of feedback',
      kinds: { problem: 'Problem', idea: 'Idea', other: 'Other' },
      label: 'Message',
      send: 'Send feedback',
      sending: 'Sending feedback…',
      noKind: 'Choose a kind of feedback.',
      empty: 'Write a message before you send.',
      refusedCharacter:
        'Your message contains a hidden character that cannot be sent. Type the message again, or paste it as plain text, then send it.',
      sent: 'Your feedback was sent to the Ekdotico team.',
      notSent: 'Your feedback was not sent. Your message is still here. Send it again, or try later.',
      privacyLink: 'Privacy notice',
    });
  });

  it('has the notice of FR-AU-72 and the link of fw-privacy-link', () => {
    expect(NOTICE).toBe(
      'Your message goes to the Ekdotico team. With it, Ekdotico sends the kind of page you are on, the Ekdotico version, your browser and its window size, and your account identifier. The content of your documents is not sent. Leave out of the message anything you do not want the team to read. Feedback is kept until 12 months after the last Closed α release.',
    );
    expect(PRIVACY_HREF).toBe('/privacy');
  });

  it('has the count, too long and too many sent', () => {
    expect(countText(12)).toBe('12 characters remaining');
    expect(countText(0)).toBe('0 characters remaining');
    expect(countText(-3)).toBe('3 characters over the limit');
    // fw-count-singular
    expect(countText(1)).toBe('1 character remaining');
    expect(countText(-1)).toBe('1 character over the limit');
    expect(tooLongText(7)).toBe(
      'The message is 7 characters over the limit of 4,000. Shorten it and send it again.',
    );
    // fw-toolong-singular
    expect(tooLongText(1)).toBe(
      'The message is 1 character over the limit of 4,000. Shorten it and send it again.',
    );
    expect(tooLongText(2)).toBe(
      'The message is 2 characters over the limit of 4,000. Shorten it and send it again.',
    );
    expect(rateLimitedText('{time}')).toBe(
      'You have sent too much feedback for now. Your message is still here. Send it again after {time}.',
    );
  });
});

describe('{time} (fw-time-format)', () => {
  const now = new Date('2026-11-22T14:00:10.000Z');
  it('is a 24-hour clock time in the given zone, rounded up to the minute', () => {
    expect(clockTime(1, now, 'UTC')).toBe('14:01');
    expect(clockTime(20 * 60 + 50, now, 'UTC')).toBe('14:21');
    expect(clockTime(20 * 60 + 50, now, 'Europe/Athens')).toBe('16:21');
    expect(clockTime(11 * 3600, now, 'UTC')).toBe('01:01');
  });
  it('has no date and no word of the day', () => {
    expect(clockTime(26 * 3600, now, 'UTC')).toMatch(/^\d\d:\d\d$/);
  });
});

describe('the count', () => {
  it('is in code points, after the white space at both ends (fw-count-unit)', () => {
    expect(countOf('  ab  ')).toBe(2);
    expect(countOf('😀'.repeat(4000))).toBe(4000);
    expect(remainingOf('  ab  ')).toBe(3998);
    expect(remainingOf('😀'.repeat(4000))).toBe(0);
    expect(remainingOf('😀'.repeat(4001))).toBe(-1);
  });
});

describe("the browser's own check", () => {
  it('asks for a kind, a message, one within the limit, and one without a refused character', () => {
    expect(checkInput(null, 'x')).toEqual({ kind: 'no_kind' });
    expect(checkInput('idea', '   ')).toEqual({ message: 'empty' });
    expect(checkInput('idea', 'a'.repeat(4001))).toEqual({ message: 'too_long' });
    expect(checkInput('idea', 'a'.repeat(4000))).toEqual({});
    expect(checkInput('idea', 'a\u0000b')).toEqual({ message: 'forbidden_character' });
    expect(checkInput('idea', 'a‮b')).toEqual({ message: 'forbidden_character' });
    expect(checkInput('problem', 'tab\there\nand a line')).toEqual({});
    expect(checkInput(null, '')).toEqual({ kind: 'no_kind', message: 'empty' });
  });
});

describe('what an answer shows (fw-refused-text: by code, never the server’s own text)', () => {
  it('takes 201 with sent true as the only success', () => {
    expect(outcomeOf(201, { sent: true })).toEqual({ kind: 'sent' });
    expect(outcomeOf(201, { sent: 'true' })).toEqual({ kind: 'not_sent' });
    expect(outcomeOf(200, { sent: true })).toEqual({ kind: 'not_sent' });
  });

  it('keeps the identifier of a 502 and nothing else of it', () => {
    expect(
      outcomeOf(502, { error: { code: 'not_sent', message: 'Anything at all' }, submissionId: 'abc-123_X' }),
    ).toEqual({
      kind: 'not_sent',
      submissionId: 'abc-123_X',
    });
    expect(outcomeOf(502, { submissionId: 'has space' })).toEqual({ kind: 'not_sent' });
  });

  it('reads the wait of a 429', () => {
    expect(outcomeOf(429, { error: { code: 'rate_limited', retryAfterSeconds: 61.2, message: '' } })).toEqual(
      {
        kind: 'rate_limited',
        retryAfterSeconds: 62,
      },
    );
    expect(outcomeOf(429, { error: { code: 'rate_limited' } })).toEqual({ kind: 'not_sent' });
  });

  it('shows a 422 as the fault it names, and the refused character by its own sentence', () => {
    expect(
      outcomeOf(422, {
        error: {
          code: 'forbidden_character',
          message: 'x',
          fields: [{ field: 'message', rule: 'forbidden_character' }],
        },
      }),
    ).toEqual({ kind: 'faults', faults: { message: 'forbidden_character' } });
    expect(
      outcomeOf(422, {
        error: {
          code: 'invalid',
          fields: [
            { field: 'kind', rule: 'required' },
            { field: 'message', rule: 'empty' },
          ],
        },
      }),
    ).toEqual({ kind: 'faults', faults: { kind: 'no_kind', message: 'empty' } });
    // A fault of a field the person cannot reach is not shown as theirs.
    expect(
      outcomeOf(422, { error: { code: 'invalid', fields: [{ field: 'route', rule: 'format' }] } }),
    ).toEqual({
      kind: 'not_sent',
    });
  });

  it('says not sent for every other answer, an unreadable one, and none', () => {
    for (const status of [null, 401, 403, 404, 500, 503])
      expect(outcomeOf(status, null)).toEqual({ kind: 'not_sent' });
    expect(outcomeOf(502, 'text')).toEqual({ kind: 'not_sent' });
  });
});

describe('the retry (fw-retry-id, fw-retry-edit)', () => {
  const attempt = { submissionId: 'id-1', kind: 'idea' as const, message: 'the same text' };
  it('sends the identifier back for the same kind and text, as they will be sent', () => {
    expect(retryId(attempt, 'idea', '  the same text \n')).toBe('id-1');
  });
  it('sends none for an edited text, another kind, or no failed send before', () => {
    expect(retryId(attempt, 'idea', 'the same text!')).toBeUndefined();
    expect(retryId(attempt, 'problem', 'the same text')).toBeUndefined();
    expect(retryId(null, 'idea', 'the same text')).toBeUndefined();
  });
});

describe('the route pattern (FR-AU-68 (a), FR-AU-69)', () => {
  it('replaces the value of each parameter by its placeholder', () => {
    expect(
      routePattern('/documents/0b6c1d7e-1111-4222-8333-944455556666', {
        id: '0b6c1d7e-1111-4222-8333-944455556666',
      }),
    ).toBe('/documents/[id]');
    expect(routePattern('/documents/abc/sharing', { id: 'abc' })).toBe('/documents/[id]/sharing');
    expect(routePattern('/', {})).toBe('/');
    expect(routePattern('/settings/delete-account', {})).toBe('/settings/delete-account');
  });
  it('sends the root rather than a path that has an identifier in it', () => {
    expect(routePattern('/documents/0B6C1D7E', {})).toBe('/');
  });
});

describe('the screen in the source', () => {
  const dialog = readFileSync('src/app/(app)/feedback-dialog.tsx', 'utf8');
  const header = readFileSync('src/app/(app)/shell-header.tsx', 'utf8');
  const layout = readFileSync('src/app/(app)/layout.tsx', 'utf8');

  it('is built from the package alone: no class of its own and no `.ekd-` class borrowed', () => {
    expect(dialog).not.toMatch(/ekd-/);
    // The one class is the reset's `sr-only`, for the spoken words of the privacy link.
    expect(dialog.match(/className=/g)).toHaveLength(1);
    expect(dialog).toMatch(/className="sr-only"/);
    expect(dialog).not.toMatch(/from '\.\.\/pages\.module\.css'/);
  });

  it('never shows the text of an error body', () => {
    expect(dialog).not.toMatch(/\.error\b|error\.message|\.message\b.*setStatus/);
  });

  it('sends the identifier the server issued and makes none', () => {
    expect(dialog).toMatch(/retryId\(attempt\.current/);
    expect(dialog).not.toMatch(/randomUUID|crypto\./);
  });

  it('is the one dialog of the header, beside two controls the CSS shows one of', () => {
    expect(header.match(/<FeedbackDialog/g)).toHaveLength(1);
    expect(header).toMatch(/links\(false\)/);
    expect(header).toMatch(/links\(true\)/);
  });

  it('is absent while the switch is off, and the header is not rendered under the Closed α notice (FR-AU-61)', () => {
    expect(layout).toMatch(/<ShellHeader feedback=\{feedbackIntakeEnabled\(\)\} \/>/);
    expect(header).toMatch(/\{feedback \? \(\s*<Button/);
    expect(header).toMatch(/\{feedback \? <FeedbackDialog/);
    // The notice returns before the header is reached.
    expect(layout.indexOf('<ClosedAlphaNotice')).toBeLessThan(layout.indexOf('<ShellHeader'));
  });

  it('works the time of a 429 out once, when it arrives, and renders that', () => {
    expect(dialog).toMatch(/time: clockTime\(outcome\.retryAfterSeconds, new Date\(\)\)/);
    expect(dialog).toMatch(/rateLimitedText\(status\.time\)/);
    expect(dialog.match(/new Date\(\)/g)).toHaveLength(1);
  });

  it('opens the privacy link in a new tab, so a half-written message is kept (FR-AU-80 (f))', () => {
    expect(dialog).toMatch(/<a href=\{PRIVACY_HREF\} target="_blank" rel="noopener noreferrer">/);
    // The spoken words of the rule for links that open a new tab, whole.
    expect(dialog).toMatch(/<span className="sr-only"> \(opens in a new tab\)<\/span>/);
  });

  it('lets the dialog out by a visible Close button and takes the focus to it once sent', () => {
    expect(dialog).toMatch(/<Button id=\{CLOSE_ID\} variant="quiet" onClick=\{dismiss\}>/);
    expect(dialog).not.toMatch(/closeLabel=/);
    expect(dialog).toMatch(
      /if \(status\.state === 'sent'\) document\.getElementById\(CLOSE_ID\)\?\.focus\(\)/,
    );
  });
});
