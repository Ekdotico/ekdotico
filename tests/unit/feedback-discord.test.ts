// FR-AU-94 (posting to Discord) and FR-AU-95 (the feedback notice and its version), at docs@e6bd892 (draft docs#154).
// The fetch is injected: nothing reaches Discord. The texts of the notice are pinned whole, as the margin notes of FR-AU-72
// give them (D503); they were compared with the docs branch by script, not retyped from memory.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discordPostingOn,
  feedbackDiscordEnabled,
  forgetSaid,
  payloadOf,
  postToDiscord,
  titleOf,
  webhookFor,
} from '../../src/lib/feedback/discord.ts';
import { acknowledged, noticeVersion } from '../../src/lib/feedback/notice.ts';
import { NOTICE, NOTICE_DISCORD, noticeRefused, noticeText } from '../../src/lib/feedback/widget.ts';

const HOOK = {
  problem: 'https://discord.com/api/webhooks/111111111111111111/aaaa_TOKEN-problem',
  idea: 'https://discord.com/api/webhooks/222222222222222222/bbbb_TOKEN-idea',
  other: 'https://discord.com/api/webhooks/333333333333333333/cccc_TOKEN-other',
};
const ON = {
  FEEDBACK_INTAKE_ENABLED: 'true',
  FEEDBACK_DISCORD_ENABLED: 'true',
  DISCORD_WEBHOOK_PROBLEM: HOOK.problem,
  DISCORD_WEBHOOK_IDEA: HOOK.idea,
  DISCORD_WEBHOOK_OTHER: HOOK.other,
};
const ACCEPTED = {
  submissionId: 'sub-1',
  kind: 'idea' as const,
  message: 'A private-looking message @everyone',
};

const answer = (status = 200) => new Response('{}', { status });

describe('the title of a post (FR-AU-94)', () => {
  it('is the whole trimmed message where it is at most 90 characters', () => {
    expect(titleOf('  Short message  ')).toBe('Short message');
    const ninety = 'a'.repeat(45) + ' ' + 'b'.repeat(44);
    expect(titleOf(ninety)).toBe(ninety);
  });
  it('is cut at a word boundary to at most 90 characters', () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const title = titleOf(words);
    expect(Array.from(title).length).toBeLessThanOrEqual(90);
    expect(words.startsWith(title)).toBe(true);
    expect(words[title.length]).toBe(' ');
    expect(title).toBe(title.trimEnd());
  });
  it('keeps the cut where it already falls on a space', () => {
    const text = 'a'.repeat(90) + ' ' + 'b'.repeat(20);
    expect(titleOf(text)).toBe('a'.repeat(90));
  });
  it('falls back to a hard cut where the first word is longer', () => {
    expect(titleOf('x'.repeat(300))).toBe('x'.repeat(90));
  });
  it('counts code points, and never splits a pair', () => {
    expect(Array.from(titleOf('😀'.repeat(200)))).toHaveLength(90);
  });
  it('makes a line break one space', () => {
    expect(titleOf('first line\n\nsecond   line')).toBe('first line second line');
  });
});

describe('the payload of a post (FR-AU-94)', () => {
  it('is the title, the whole message in an embed, and no mentions, and no other field', () => {
    const message = 'x'.repeat(95) + '\nand more';
    expect(payloadOf(`  ${message}  `)).toEqual({
      thread_name: 'x'.repeat(90),
      embeds: [{ description: message }],
      allowed_mentions: { parse: [] },
    });
    expect(Object.keys(payloadOf('m')).sort()).toEqual(['allowed_mentions', 'embeds', 'thread_name']);
    expect(Object.keys(payloadOf('m').embeds[0]!)).toEqual(['description']);
  });
  it('holds the 4,000 characters whole', () => {
    expect(payloadOf('y'.repeat(4000)).embeds[0]!.description).toHaveLength(4000);
  });
});

describe('the switches and the webhooks', () => {
  it('reads the second switch as the first is read: off unless `true`, a mistake otherwise', () => {
    expect(feedbackDiscordEnabled({})).toBe(false);
    expect(feedbackDiscordEnabled({ FEEDBACK_DISCORD_ENABLED: '' })).toBe(false);
    expect(feedbackDiscordEnabled({ FEEDBACK_DISCORD_ENABLED: 'false' })).toBe(false);
    expect(feedbackDiscordEnabled({ FEEDBACK_DISCORD_ENABLED: 'true' })).toBe(true);
    expect(() => feedbackDiscordEnabled({ FEEDBACK_DISCORD_ENABLED: 'yes' })).toThrow();
  });
  it('posts only while both are on', () => {
    expect(discordPostingOn(ON)).toBe(true);
    expect(discordPostingOn({ ...ON, FEEDBACK_INTAKE_ENABLED: 'false' })).toBe(false);
    expect(discordPostingOn({ ...ON, FEEDBACK_DISCORD_ENABLED: 'false' })).toBe(false);
    expect(discordPostingOn({ FEEDBACK_DISCORD_ENABLED: 'true' })).toBe(false);
  });
  it('accepts only a webhook address on discord.com', () => {
    expect(webhookFor('problem', ON)).toBe(HOOK.problem);
    for (const bad of [
      '',
      'http://discord.com/api/webhooks/1/abc',
      'https://discord.com.evil.example/api/webhooks/1/abc',
      'https://evil.example/api/webhooks/1/abc',
      'https://discordapp.com/api/webhooks/1/abc',
      'https://discord.com/api/webhooks/1/abc?x=1',
      'https://discord.com/api/webhooks/1',
      'https://user@discord.com/api/webhooks/1/abc',
    ]) {
      expect(webhookFor('problem', { DISCORD_WEBHOOK_PROBLEM: bad })).toBeNull();
    }
    expect(webhookFor('problem', {})).toBeNull();
  });
});

describe('postToDiscord (FR-AU-94)', () => {
  beforeEach(() => forgetSaid());

  it('posts to the webhook of the kind, with ?wait=true, and the payload alone', async () => {
    for (const kind of ['problem', 'idea', 'other'] as const) {
      const fetch = vi.fn(async () => answer(200));
      const log = vi.fn();
      await postToDiscord({ ...ACCEPTED, kind }, { fetch, env: ON, log });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${HOOK[kind]}?wait=true`);
      expect(init.method).toBe('POST');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(init.body as string)).toEqual(payloadOf(ACCEPTED.message));
      expect(log).toHaveBeenCalledWith('feedback sub-1: posted to discord');
    }
  });

  it('sends nothing of the submission but the kind (to choose the channel) and the message', async () => {
    const fetch = vi.fn(async () => answer(200));
    await postToDiscord(
      { ...ACCEPTED, accountId: 'acc-9', route: '/x', appVersion: '1', browser: {}, viewport: {} } as never,
      { fetch, env: ON, log: () => {} },
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const sent = `${url} ${JSON.stringify(init)}`;
    for (const absent of ['acc-9', '"/x"', 'sub-1', 'viewport', 'browser', 'appVersion']) {
      expect(sent).not.toContain(absent);
    }
  });

  it('makes no request while either switch is off, or the second holds a mistake', async () => {
    for (const env of [
      { ...ON, FEEDBACK_DISCORD_ENABLED: 'false' },
      { ...ON, FEEDBACK_INTAKE_ENABLED: 'false' },
      { ...ON, FEEDBACK_DISCORD_ENABLED: undefined },
      { ...ON, FEEDBACK_DISCORD_ENABLED: 'maybe' },
    ]) {
      const fetch = vi.fn(async () => answer());
      const log = vi.fn();
      await expect(postToDiscord(ACCEPTED, { fetch, env, log })).resolves.toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it('makes no request where the webhook is missing or invalid, and says so once, without the address', async () => {
    const fetch = vi.fn(async () => answer());
    const log = vi.fn();
    const env = { ...ON, DISCORD_WEBHOOK_IDEA: 'https://evil.example/api/webhooks/1/SECRETTOKEN' };
    await postToDiscord(ACCEPTED, { fetch, env, log });
    await postToDiscord(ACCEPTED, { fetch, env, log });
    expect(fetch).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('DISCORD_WEBHOOK_IDEA');
    expect(String(log.mock.calls[0]![0])).not.toContain('SECRETTOKEN');
  });

  it('logs a refusal by its status and the identifier, and does not repeat it', async () => {
    const fetch = vi.fn(async () => answer(429));
    const log = vi.fn();
    await postToDiscord(ACCEPTED, { fetch, env: ON, log });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('feedback sub-1: not posted to discord (status 429)');
  });

  it('logs a thrown fault and a timeout without the message and without the address, and resolves', async () => {
    for (const [fault, outcome] of [
      [new Error(`boom ${HOOK.idea} ${ACCEPTED.message}`), 'error'],
      [Object.assign(new Error('late'), { name: 'TimeoutError' }), 'timeout'],
    ] as const) {
      const fetch = vi.fn(async () => {
        throw fault;
      });
      const log = vi.fn();
      await expect(postToDiscord(ACCEPTED, { fetch, env: ON, log })).resolves.toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(`feedback sub-1: not posted to discord (${outcome})`);
    }
  });

  it('logs nothing secret or private on any path', async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    await postToDiscord(ACCEPTED, { fetch: async () => answer(200), env: ON, log });
    await postToDiscord(ACCEPTED, { fetch: async () => answer(500), env: ON, log });
    await postToDiscord(ACCEPTED, {
      fetch: async () => {
        throw new Error(HOOK.idea);
      },
      env: ON,
      log,
    });
    await postToDiscord(ACCEPTED, {
      fetch: async () => answer(),
      env: { ...ON, DISCORD_WEBHOOK_IDEA: '' },
      log,
    });
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of ['TOKEN', 'discord.com/api', 'private-looking', '@everyone', 'acc-']) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('the texts of the notice (FR-AU-72, D503)', () => {
  it('is the text of FR-AU-72 while posting is off', () => {
    expect(noticeText(false)).toBe(NOTICE);
    expect(NOTICE).toBe(
      'Your message goes to the Ekdotico team. With it, Ekdotico sends the kind of page you are on, the Ekdotico version, your browser and its window size, and your account identifier. The content of your documents is not sent. Leave out of the message anything you do not want the team to read. Feedback is kept until 12 months after the last Closed α release.',
    );
  });
  it('is the text of D503 while posting is on', () => {
    expect(noticeText(true)).toBe(NOTICE_DISCORD);
    expect(NOTICE_DISCORD).toBe(
      'Your message goes to the Ekdotico team, and the message and its kind, with nothing else, are posted to the Ekdotico community on Discord, where its members can read them and vote. With it, Ekdotico sends the team the kind of page you are on, the Ekdotico version, your browser and its window size, and your account identifier; none of these is posted. The content of your documents is not sent. Leave out of the message anything you do not want the community to read. Feedback is kept until 12 months after the last Closed α release.',
    );
  });
});

describe('the refusal for the feedback notice (FR-AU-95)', () => {
  it('is read from its status and code alone', () => {
    const body = { error: { code: 'feedback_notice_not_acknowledged', message: '' } };
    expect(noticeRefused(403, body)).toBe(true);
    expect(noticeRefused(401, body)).toBe(false);
    expect(noticeRefused(403, { error: { code: 'notice_not_acknowledged' } })).toBe(false);
    expect(noticeRefused(403, null)).toBe(false);
    expect(noticeRefused(null, undefined)).toBe(false);
  });
});

describe('the version of the feedback notice (FR-AU-95, D506)', () => {
  it('is 1 while posting is off and 2 while it is on', () => {
    expect(noticeVersion(false)).toBe(1);
    expect(noticeVersion(true)).toBe(2);
  });
  it('shows the notice again to an account that acknowledged a lower version, and never to one that has the current', () => {
    expect(acknowledged(null, 1)).toBe(false);
    expect(acknowledged(1, 1)).toBe(true);
    expect(acknowledged(1, 2)).toBe(false);
    expect(acknowledged(2, 2)).toBe(true);
    expect(acknowledged(2, 1)).toBe(true);
  });
});
