// The one way the application sends email (FR-AU-87). Plain text only. Today it
// writes each message to a file in a local directory and sends nothing.
//
// NFR-SE-19: nothing here logs. An address, a subject, or a body, which may
// hold the token of a single-use link, never reaches a log or an error message.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { settings } from '../settings.ts';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Sends one message. Rejects if it could not be handed over. */
export async function sendEmail(message: EmailMessage): Promise<void> {
  // A carriage return or a line feed in a header value would add a header.
  // The error does not repeat the value (NFR-SE-19).
  if (/[\r\n]/.test(message.to)) throw new Error('The recipient address must not contain a line break.');
  if (/[\r\n]/.test(message.subject)) throw new Error('The subject must not contain a line break.');

  // The Scaleway sender (register D70, D92) is selected here, once the owner has confirmed
  // the three checks that stand with D70: the agreement, the retention, and the standing of its API.
  const { emailSinkDirectory, emailFrom } = settings();
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
