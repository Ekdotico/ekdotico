// The one way the application sends email (FR-AU-87). Plain text only. Two
// transports, chosen by `EMAIL_TRANSPORT`: Brevo over its HTTPS API (register
// D206, D262), and a local sink that writes each message to a file and sends
// nothing.
//
// NFR-SE-19: nothing here logs. An address, a subject, or a body, which may
// hold the token of a single-use link, never reaches a log or an error message.
// Nor does the key of Brevo, or anything Brevo answers: its error `message` may
// quote the email. The status code is what an error keeps of an answer, and of a
// 400 the `code` as well, but only through a fixed list that maps it to a label of
// ours: nothing else of the body is kept.
//
// There are no retries here. `handOver` retries the email of an account (FR-AU-87:
// "one sent twice does no harm"). The email of a document invitation marks its row
// before it calls this and is not tried again where the outcome is unknown
// (FR-ED-21), so a timeout cannot send it twice. Where the service CERTAINLY did
// not take it (`certainlyNotTaken`), src/lib/email/queue.ts keeps it for a later
// attempt (D263).
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { printableCode } from '../fault.ts';
import { settings, type EmailSender } from '../settings.ts';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const BREVO_TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** A fault of the message itself: it will be refused however often it is sent, so it is not tried again. */
export class MessageRefused extends Error {
  name = 'MessageRefused';
}

/**
 * Brevo says it has seen this message already (`duplicate_request`), so it very likely arrived. It is not
 * refused, and it is not sent again.
 */
export class MessageSentAlready extends Error {
  name = 'MessageSentAlready';
}

/** Sends one message. Rejects if it could not be handed over. */
export async function sendEmail(message: EmailMessage): Promise<void> {
  // A carriage return or a line feed in a header value would add a header.
  // The error does not repeat the value (NFR-SE-19).
  if (/[\r\n]/.test(message.to)) {
    throw new MessageRefused('The recipient address must not contain a line break.');
  }
  if (/[\r\n]/.test(message.subject)) throw new MessageRefused('The subject must not contain a line break.');

  const { emailTransport, emailSinkDirectory, emailFrom, emailSender, brevoApiKey } = settings();
  if (emailTransport === 'brevo') {
    // The collaboration server is loaded without the key (settings.ts) and sends no email.
    if (!brevoApiKey || !emailSender) throw fault('This process holds no key for Brevo.');
    return sendThroughBrevo(brevoApiKey, emailSender, message);
  }

  const now = new Date();
  // The name holds neither the address nor the subject. The time sorts the files;
  // the random suffix keeps two messages in one millisecond apart.
  const name = `${now.toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}.eml`;
  const file = [
    `From: ${emailFrom}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    `Date: ${now.toUTCString()}`,
    '',
    message.text,
  ].join('\n');

  try {
    await mkdir(emailSinkDirectory, { recursive: true, mode: 0o700 });
    // 0600: the file holds an address and may hold a single-use link. 'wx' never overwrites.
    await writeFile(join(emailSinkDirectory, name), file, { mode: 0o600, flag: 'wx' });
  } catch (cause) {
    // The file system error names a path and an error code, never the message.
    throw new Error('The email sink could not store the message.', { cause });
  }
}

// An error with no cause and no message of anyone's: `code` is what `faultOf` prints beside the class (a
// short string of letters and digits, so an address cannot be one).
const fault = (message: string, code?: string) => Object.assign(new Error(message), code ? { code } : {});

// What of a fault of `fetch` may be kept: the code of its cause (`ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`),
// or that the timeout fired. Never the error itself, nor its cause, which can hold the request's URL, its
// headers, or its body.
function codeOf(error: unknown): string | undefined {
  if (error instanceof Error && error.name === 'TimeoutError') return 'Timeout';
  return printableCode((error as { cause?: { code?: unknown } } | null)?.cause?.code);
}

// D263, NFR-RE-15: the service certainly did not take the message where it answered 401, 402, 403 or 429, or a
// 400 for its credits, its key, or its domain, or where no connection was made. The codes are those the sender
// puts on its faults, and nothing else is certain: a timeout (`Timeout`, `UND_ERR_CONNECT_TIMEOUT`), a broken
// connection, a 5xx, any other 400, and a fault that has no code are an unknown outcome, and a message that the
// service refuses for itself (`MessageRefused`) is not tried again.
const NOT_TAKEN = new Set([
  '401',
  '402',
  '403',
  '429',
  '400_CREDITS',
  '400_KEY',
  '400_DOMAIN',
  // No connection was made: refused, no such host, no resolver, no route.
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/** Whether the fault of `sendEmail` says the service certainly did not take the message (D263). */
export function certainlyNotTaken(error: unknown): boolean {
  if (error instanceof MessageRefused || error instanceof MessageSentAlready) return false;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && NOT_TAKEN.has(code);
}

// The `code` of a 400 that Brevo's reference lists, and the label of ours that stands for it. A code that is
// not listed has no label, and the label is all that is kept: the code itself is what the body quoted.
const LABELS = new Map([
  ['invalid_parameter', 'INVALID'],
  ['missing_parameter', 'MISSING'],
  ['out_of_range', 'RANGE'],
  ['duplicate_request', 'DUPLICATE'],
  ['Request already processed', 'DUPLICATE'],
  ['not_enough_credits', 'CREDITS'],
  ['Insufficient credits', 'CREDITS'],
  ['permission_denied', 'PERMISSION'],
  ['account_under_validation', 'VALIDATION'],
  ['api-key not found', 'KEY'],
  ['Authentication failed', 'KEY'],
  ['unauthorized', 'KEY'],
  ['DMARC policy requires domain authentication', 'DOMAIN'],
  ['DNS records not properly configured', 'DOMAIN'],
  ['Domain does not exist', 'DOMAIN'],
]);
// What a 400 says of the message itself: refused however often it is sent.
const REFUSED = new Set(['INVALID', 'MISSING', 'RANGE']);

// Reads the body of a 400 for its `code` alone, and drops the rest. Its `message` may quote the email, and
// is never touched. A body that does not parse has no code.
async function labelOf(response: Response): Promise<string | undefined> {
  try {
    const code = ((await response.json()) as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? LABELS.get(code) : undefined;
  } catch {
    return undefined;
  }
}

// Register D262. The key travels in one header, to one host, and the request follows no redirect, so it
// cannot be sent anywhere else. The body holds the sender, the one recipient, the subject, and the text:
// no HTML, no reply-to, no tag, no idempotency key (FR-ED-21 does not rely on one), no header of our own.
// `contactPixelTrackingConsent: false` says the recipient has not agreed to tracking. Brevo ignores it unless
// the account has the setting for it; tracking is made anonymous in the account, by the owner (D262).
async function sendThroughBrevo(key: string, sender: EmailSender, message: EmailMessage): Promise<void> {
  let response: Response;
  try {
    response = await fetch(BREVO_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
      headers: { 'api-key': key, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: sender.name, email: sender.email },
        to: [{ email: message.to, contactPixelTrackingConsent: false }],
        subject: message.subject,
        textContent: message.text,
      }),
    });
  } catch (error) {
    throw fault('Brevo could not be reached.', codeOf(error));
  }
  // The answer is not read, but for the `code` of a 400: its `message` may quote the email.
  const label = response.status === 400 ? await labelOf(response) : undefined;
  void response.body?.cancel().catch(() => {});
  // 201 sent, 202 scheduled.
  if (response.status === 201 || response.status === 202) return;
  if (response.status === 400) {
    // A message that Brevo refuses will be refused each time: not tried again.
    if (label && REFUSED.has(label)) {
      throw Object.assign(new MessageRefused('Brevo refused the message (status 400).'), { code: label });
    }
    // It has seen it already: it very likely arrived, and a second send would be a second email.
    if (label === 'DUPLICATE') {
      throw Object.assign(new MessageSentAlready('Brevo has seen the message already (status 400).'), {
        code: label,
      });
    }
    // Any other 400 (no credits, an unverified sender or domain, a key it does not know) is a fault of the
    // account and not of the message, and is tried again once it is mended.
    throw fault('Brevo answered with status 400.', label ? `400_${label}` : '400');
  }
  throw fault(`Brevo answered with status ${response.status}.`, String(response.status));
}
