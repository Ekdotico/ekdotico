import { describe, expect, it } from 'vitest';
import { loadSettings } from '../../src/lib/settings.ts';

describe('loadSettings (FR-AU-83; register A102)', () => {
  it('refuses to start where FOUNDING_TEAM_EMAILS is absent', () => {
    expect(() => loadSettings({})).toThrow(/FOUNDING_TEAM_EMAILS/);
  });

  it('accepts a list with no address, written as an empty value', () => {
    expect(loadSettings({ FOUNDING_TEAM_EMAILS: '' }).foundingTeamEmails).toEqual([]);
  });

  it('reads addresses separated by commas, without regard to case', () => {
    const { foundingTeamEmails } = loadSettings({
      FOUNDING_TEAM_EMAILS: ' One@Example.com,two@example.com ,',
    });
    expect(foundingTeamEmails).toEqual(['one@example.com', 'two@example.com']);
  });
});
