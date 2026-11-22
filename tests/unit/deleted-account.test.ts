// What stands for an account that was deleted, and the pieces of the deletion that need no database
// (FR-AU-58; docs/plan/slice-22.md). The rest is in tests/integration/account-deletion.test.ts.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DELETED_ACCOUNT } from '../../src/lib/account/deleted-account.ts';
import {
  FeedbackNotAcknowledged,
  FeedbackSwitchInvalid,
  feedbackIntakeEnabled,
  feedbackStep,
} from '../../src/lib/account/feedback-step.ts';
import {
  newPseudonym,
  PSEUDONYM_ADJECTIVES,
  PSEUDONYM_ANIMALS,
  withoutSenderName,
} from '../../src/lib/documents/pseudonym.ts';
import { Sender } from '../../src/app/(app)/invitations/invitation-view.tsx';

describe('the fixed text for a deleted account (FR-AU-58 (e))', () => {
  it('is verbatim', () => {
    expect(DELETED_ACCOUNT).toBe('Deleted account');
  });

  it('stands where the sender of an invitation has no name and no address left, and nowhere a name is', () => {
    expect(renderToStaticMarkup(createElement(Sender, { name: '', email: null }))).toBe(
      '<bdi>Deleted account</bdi>',
    );
    expect(renderToStaticMarkup(createElement(Sender, { name: 'Ada Owner', email: 'ada@example.com' }))).toBe(
      '<bdi>Ada Owner</bdi> (<bdi>ada@example.com</bdi>)',
    );
    expect(renderToStaticMarkup(createElement(Sender, { name: 'Ada Owner', email: null }))).toBe(
      '<bdi>Ada Owner</bdi>',
    );
  });
});

describe('the pseudonym of an invitation of a deleted sender (docs/plan/invitation-title.md)', () => {
  it('keeps the two words and loses the name', () => {
    expect(withoutSenderName('Flying Hippos — Ada Owner')).toBe('Flying Hippos — Deleted account');
  });

  it('loses a name that holds the separator itself, and a name that is another pseudonym', () => {
    expect(withoutSenderName('Calm Owls — Ada — Owner')).toBe('Calm Owls — Deleted account');
    expect(withoutSenderName('Calm Owls — Brave Otters — Ada')).toBe('Calm Owls — Deleted account');
  });

  it('becomes the fixed text alone where it is not of the form that is made, so that no name survives', () => {
    expect(withoutSenderName('Ada Owner')).toBe(DELETED_ACCOUNT);
    expect(withoutSenderName('')).toBe(DELETED_ACCOUNT);
  });

  it('strips every pseudonym that is made: the words never hold the separator', () => {
    PSEUDONYM_ADJECTIVES.forEach((adjective, first) => {
      PSEUDONYM_ANIMALS.forEach((animal, second) => {
        // The adjective is drawn first and the animal second.
        const picks = [first, second];
        const made = newPseudonym('Ada Owner', () => picks.shift()!);
        expect(made).toBe(`${adjective} ${animal} — Ada Owner`);
        expect(withoutSenderName(made)).toBe(`${adjective} ${animal} — ${DELETED_ACCOUNT}`);
      });
    });
  });
});

describe('the switch of step (c) (FR-AU-58 (c); D112)', () => {
  it('is off where it is not set, empty, or false, and on for true', () => {
    expect(feedbackIntakeEnabled({})).toBe(false);
    expect(feedbackIntakeEnabled({ FEEDBACK_INTAKE_ENABLED: '' })).toBe(false);
    expect(feedbackIntakeEnabled({ FEEDBACK_INTAKE_ENABLED: 'false' })).toBe(false);
    expect(feedbackIntakeEnabled({ FEEDBACK_INTAKE_ENABLED: 'true' })).toBe(true);
  });

  it.each(['TRUE', 'True', '1', 'yes', 'on', ' true', 'true '])('refuses to read %j either way', (value) => {
    expect(() => feedbackIntakeEnabled({ FEEDBACK_INTAKE_ENABLED: value })).toThrow(FeedbackSwitchInvalid);
    expect(() => feedbackIntakeEnabled({ FEEDBACK_INTAKE_ENABLED: value })).toThrow(
      'FEEDBACK_INTAKE_ENABLED must be true or false.',
    );
  });

  it('is read from the environment of the process by default, at the time of the step and not before', () => {
    const before = process.env.FEEDBACK_INTAKE_ENABLED;
    try {
      process.env.FEEDBACK_INTAKE_ENABLED = 'true';
      expect(feedbackIntakeEnabled()).toBe(true);
      process.env.FEEDBACK_INTAKE_ENABLED = 'false';
      expect(feedbackIntakeEnabled()).toBe(false);
    } finally {
      if (before === undefined) delete process.env.FEEDBACK_INTAKE_ENABLED;
      else process.env.FEEDBACK_INTAKE_ENABLED = before;
    }
  });

  it('makes no call with the switch off, whatever the intake would answer', async () => {
    const pseudonymise = vi.fn(async () => true);
    await expect(feedbackStep('user-1', { enabled: () => false, intake: { pseudonymise } })).resolves.toBe(
      'skipped',
    );
    expect(pseudonymise).not.toHaveBeenCalled();
  });

  it('makes one call for the account with the switch on, and is done only on an acknowledgement', async () => {
    const pseudonymise = vi.fn(async () => true);
    const wait = async () => {};
    await expect(
      feedbackStep('user-1', { enabled: () => true, wait, intake: { pseudonymise } }),
    ).resolves.toBe('done');
    expect(pseudonymise).toHaveBeenCalledExactlyOnceWith('user-1');
    await expect(
      feedbackStep('user-1', { enabled: () => true, wait, intake: { pseudonymise: async () => false } }),
    ).rejects.toThrow('The feedback intake did not acknowledge.');
    await expect(
      feedbackStep('user-1', {
        enabled: () => true,
        wait,
        intake: {
          pseudonymise: async () => {
            throw new Error('down');
          },
        },
      }),
    ).rejects.toBeInstanceOf(FeedbackNotAcknowledged);
  });
});
