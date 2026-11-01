// The one way the application sends email (FR-AU-87). Plain text only. Two
// transports, chosen by `EMAIL_TRANSPORT`: Brevo over its HTTPS API (register
// D206, D262), and a local sink that writes each message to a file and sends
// nothing.
//
// NFR-SE-19: nothing here logs. An address, a subject, or a body, which may
// hold the token of a single-use link, never reaches a log or an error message.
// Nor does the key of Brevo, or anything Brevo answers: its error `message` may
// quote the email. The status code is all of an answer that appears in an error.
//
// There are no retries here. `handOver` retries the email of an account (FR-AU-87:
// "one sent twice does no harm"). The email of a document invitation marks its row
// before it calls this and is never tried again (FR-ED-21), so a timeout, where
// the outcome is unknown, cannot send it twice.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

/** Sends one message. Rejects if it could not be handed over. */
export async function sendEmail(message: EmailMessage): Promise<void> {
  // A carriage return or a line feed in a header value would add a header.
  // The error does not repeat the value (NFR-SE-19).
  if (/[\r\n]/.test(message.to)) {
    throw new MessageRefused('The recipient address must not contain a line break.');
  }
  if (/[\r\n]/.test(message.subject)) throw new MessageRefused('The subject must not contain a line break.');

  const { emailTransport, emailSinkDirectory, emailFrom, emailSender, brevoApiKey } = settings();
  if (emailTransport === 'brevo') return sendThroughBrevo(brevoApiKey!, emailSender!, message);

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

// What of a fault of `fetch` may be kept: the code of its cause (`ECONNREFUSED`), or that the timeout fired.
// Never the error itself, nor its cause, which can hold the request's URL, its headers, or its body.
function codeOf(error: unknown): string | undefined {
  if (error instanceof Error && error.name === 'TimeoutError') return 'Timeout';
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && /^[A-Za-z0-9]{1,16}$/.test(code) ? code : undefined;
}

// Register D262. The key travels in one header, to one host, and the request follows no redirect, so it
// cannot be sent anywhere else. The body holds the sender, the one recipient, the subject, and the text:
// no HTML, no reply-to, no tag, no idempotency key (FR-ED-21 does not rely on one), no header of our own.
// `contactPixelTrackingConsent: false` tells Brevo the recipient has not agreed to tracking, so that its
// events are anonymised; the plain text carries no pixel.
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
  // The answer is never read: its `message` may quote the email. Only its status is kept.
  void response.body?.cancel().catch(() => {});
  // 201 sent, 202 scheduled.
  if (response.status === 201 || response.status === 202) return;
  // A message that Brevo refuses will be refused each time: not tried again.
  if (response.status === 400) throw new MessageRefused('Brevo refused the message (status 400).');
  throw fault(`Brevo answered with status ${response.status}.`, String(response.status));
}
