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
export function titleOf(message: string): string {
  const text = message.trim().replace(/\s+/g, ' ');
  const chars = Array.from(text);
  if (chars.length <= TITLE_MAX) return text;
  const head = chars.slice(0, TITLE_MAX);
  // The cut already falls between two words.
  if (chars[TITLE_MAX] === ' ') return head.join('');
  const space = head.lastIndexOf(' ');
  return (space > 0 ? head.slice(0, space) : head).join('');
}

// A letter, a number, a mark of punctuation or a symbol: what a reader can see. Format characters (U+200B and the like) are none.
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** The body of the request to the webhook: the title, the message whole in an embed, and no one mentioned. */
export function payloadOf(message: string, kind: Kind) {
  const whole = message.trim();
  const title = titleOf(whole);
  return {
    // A title with nothing to see in it (white space and zero-width characters only) is the label of the kind instead.
    thread_name: VISIBLE.test(title) ? title : WIDGET_TEXT.kinds[kind],
    embeds: [{ description: whole }],
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
