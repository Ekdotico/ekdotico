// Posting an accepted submission to the Ekdotico community on Discord (FR-AU-94; register D502, A108).
//
// THIS IS THE ONE PLACE THAT READS `FEEDBACK_DISCORD_ENABLED`, as src/lib/account/feedback-step.ts is the one place
// that reads `FEEDBACK_INTAKE_ENABLED`. Posting is on only while both are on (`discordPostingOn`).
//
// What leaves for Discord is the kind and the message, and nothing else: no account, route, browser, version or
// submission identifier. The three webhook addresses are secrets held in the server environment alone: they are never
// logged and never sent to a browser. A post that fails is logged with the submission identifier and the outcome, never
// the message, and is not repeated, so it can never change the answer the user receives.
import { feedbackIntakeEnabled } from '../account/feedback-step.ts';
import type { Kind } from './validate.ts';
import { WIDGET_TEXT } from './widget.ts';

type Env = Record<string, string | undefined>;

/** FR-AU-94: the title is at most this many characters (Discord's own limit is 100). */
export const TITLE_MAX = 90;
/** A few seconds, so that a slow Discord holds nothing of the request; the post runs after the response. */
export const POST_TIMEOUT_MS = 5000;

const WEBHOOK_NAMES: Record<Kind, string> = {
  problem: 'DISCORD_WEBHOOK_PROBLEM',
  idea: 'DISCORD_WEBHOOK_IDEA',
  other: 'DISCORD_WEBHOOK_OTHER',
};

/** The second switch is off where it is not set, empty, or `false`; on for `true`; anything else is a mistake. */
export class FeedbackDiscordSwitchInvalid extends Error {
  name = 'FeedbackDiscordSwitchInvalid';
}

export function feedbackDiscordEnabled(env: Env = process.env): boolean {
  const value = env.FEEDBACK_DISCORD_ENABLED;
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new FeedbackDiscordSwitchInvalid('FEEDBACK_DISCORD_ENABLED must be true or false.');
}

/** Whether accepted feedback is posted: both switches on (FR-AU-94). The notice's text and version follow it (D503, D506). */
export function discordPostingOn(env: Env = process.env): boolean {
  return feedbackIntakeEnabled(env) && feedbackDiscordEnabled(env);
}

// Only the address of a webhook on Discord itself, with an identifier and a token and nothing after them.
const WEBHOOK = /^https:\/\/discord\.com\/api\/webhooks\/[0-9]{1,30}\/[A-Za-z0-9_-]{1,200}$/;

/** The webhook of a kind, or null where it is missing or is not a Discord webhook address. */
export function webhookFor(kind: Kind, env: Env = process.env): string | null {
  const value = env[WEBHOOK_NAMES[kind]];
  return value !== undefined && WEBHOOK.test(value) ? value : null;
}

/**
 * FR-AU-94: the start of the message, cut at a word boundary to at most 90 characters (code points), falling back to
 * a hard cut where the first word is longer. White space runs, line breaks included, are one space in a title.
 */
export function titleOf(message: string, max = TITLE_MAX): string {
  const text = message.trim().replace(/\s+/g, ' ');
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max);
  // The cut already falls between two words.
  if (chars[max] === ' ') return head.join('');
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).join('');
}

// A letter, a number, a mark of punctuation or a symbol: what a reader can see. Format characters (U+200B and the like) are none.
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** Discord's limits on the two texts, after escaping (a thread name and an embed description). */
export const THREAD_NAME_LIMIT = 100;
export const DESCRIPTION_LIMIT = 4096;

/**
 * D509: every character of Discord's Markdown is escaped with a backslash, so that a post shows what was typed, as plain text:
 * no masked link, no formatting, no heading, no list. The characters are `\ * _ ~ ` | > # - [ ] ( )` (so a leading `-#` is
 * covered), and a list marker at the start of a line: `+`, and a number with a stop after it. `@` is not one: a mention is
 * made inert by `allowed_mentions`, which the payload sets and escaping leaves as it is.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/[\\*_~`|>#\-[\]()]/g, '\\$&')
    .replace(/^([ \t]*)\+/gm, '$1\\+')
    .replace(/^([ \t]*\d+)\./gm, '$1\\.');
}

const ELLIPSIS = '…';

/** The title: cut as FR-AU-94 says on the text before escaping, escaped, and cut further where escaping pushed it past 100. */
function threadName(whole: string, kind: Kind): string {
  for (let max = TITLE_MAX; max > 0; max -= 1) {
    const title = titleOf(whole, max);
    // A title with nothing to see in it (white space and zero-width characters only) is the label of the kind instead.
    if (!VISIBLE.test(title)) return WIDGET_TEXT.kinds[kind];
    const escaped = escapeMarkdown(title);
    if (Array.from(escaped).length <= THREAD_NAME_LIMIT) return escaped;
  }
  return WIDGET_TEXT.kinds[kind];
}

/**
 * The description: the whole message, escaped. The 4,000 characters of FR-AU-66 are counted before escaping; where escaping
 * takes the text past Discord's 4,096 it is cut at the end, between two characters of the original, and ends in an ellipsis.
 */
function description(whole: string): string {
  const escaped = escapeMarkdown(whole);
  if (Array.from(escaped).length <= DESCRIPTION_LIMIT) return escaped;
  let chars = Array.from(whole);
  for (;;) {
    const excess = Array.from(escapeMarkdown(chars.join(''))).length + 1 - DESCRIPTION_LIMIT;
    if (excess <= 0) return escapeMarkdown(chars.join('')) + ELLIPSIS;
    chars = chars.slice(0, Math.max(0, chars.length - Math.ceil(excess / 2)));
  }
}

/** The body of the request to the webhook: the title, the message whole in an embed, as plain text, and no one mentioned. */
export function payloadOf(message: string, kind: Kind) {
  const whole = message.trim();
  return {
    thread_name: threadName(whole, kind),
    embeds: [{ description: description(whole) }],
    allowed_mentions: { parse: [] as string[] },
  };
}

/** What a post is given: the three things FR-AU-94 allows to be used, the identifier for the log alone. */
export interface Accepted {
  submissionId: string;
  kind: Kind;
  message: string;
}

export interface Dependencies {
  fetch?: typeof fetch;
  env?: Env;
  log?: (line: string) => void;
  timeoutMs?: number;
}

// A webhook that is missing or invalid is said once for each kind, and without the address.
const said = new Set<Kind>();
/** For a test: forget what was said. */
export function forgetSaid(): void {
  said.clear();
}

/**
 * Posts one accepted submission. Never throws and never rejects: every failure is a line of the log. Makes no request
 * where either switch is off, where the switch holds a mistake, or where the webhook of the kind is not usable.
 */
export async function postToDiscord(accepted: Accepted, dependencies: Dependencies = {}): Promise<void> {
  const {
    env = process.env,
    log = (line: string) => console.info(line),
    timeoutMs = POST_TIMEOUT_MS,
  } = dependencies;
  const send = dependencies.fetch ?? fetch;
  const { submissionId, kind, message } = accepted;
  try {
    if (!discordPostingOn(env)) return;
    const webhook = webhookFor(kind, env);
    if (webhook === null) {
      if (!said.has(kind)) {
        said.add(kind);
        log(`feedback discord: ${WEBHOOK_NAMES[kind]} is missing or is not a Discord webhook address`);
      }
      return;
    }
    const response = await send(`${webhook}?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadOf(message, kind)),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Read to its end, so that the connection is freed; what it says is of no use.
    await response.arrayBuffer().catch(() => undefined);
    log(
      response.ok
        ? `feedback ${submissionId}: posted to discord`
        : `feedback ${submissionId}: not posted to discord (status ${response.status})`,
    );
  } catch (error) {
    // The class of the fault only: a message could carry the address.
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    log(`feedback ${submissionId}: not posted to discord (${timedOut ? 'timeout' : 'error'})`);
  }
}
