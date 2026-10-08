import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// FR-AU-87 (the email of the account), NFR-SE-19 (what no log holds).
const ENV = [
  'EMAIL_SINK_DIRECTORY',
  'EMAIL_FROM',
  'FOUNDING_TEAM_EMAILS',
  'APP_ORIGIN',
  'DATABASE_URL',
  'VALKEY_URL',
  'AUTH_SECRET',
] as const;
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

let root: string;
let sink: string;

// settings() reads the environment once per module instance, so each test imports afresh.
async function load() {
  vi.resetModules();
  return import('../../src/lib/email/index.ts');
}

const files = () => (readdirSync(sink, { withFileTypes: true }).length ? readdirSync(sink).sort() : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ekdotico-email-'));
  sink = join(root, 'mail'); // absent: the sink creates it
  process.env.EMAIL_SINK_DIRECTORY = sink;
  process.env.EMAIL_FROM = 'Ekdotico <no-reply@example.com>';
  process.env.FOUNDING_TEAM_EMAILS = '';
  process.env.APP_ORIGIN = 'http://localhost:3000';
  process.env.DATABASE_URL = 'postgresql://fake:fake@localhost:5432/fake';
  process.env.VALKEY_URL = 'redis://localhost:6379';
  process.env.AUTH_SECRET = 'fake-secret-for-tests-only-0123456789abcdef';
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('sendEmail, local sink', () => {
  it('writes the message with its headers and text, readable by its owner alone', async () => {
    const { sendEmail } = await load();
    await sendEmail({
      to: 'reader@example.com',
      subject: 'Reset your password',
      text: 'Line one.\nLine two.',
    });

    const [name] = files();
    expect(files()).toHaveLength(1);
    const path = join(sink, name!);
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines[0]).toBe('From: Ekdotico <no-reply@example.com>');
    expect(lines[1]).toBe('To: reader@example.com');
    expect(lines[2]).toBe('Subject: Reset your password');
    expect(lines[3]).toMatch(/^Date: \w{3}, \d{2} \w{3} \d{4} [\d:]{8} GMT$/);
    expect(lines.slice(4)).toEqual(['', 'Line one.', 'Line two.']);
    // NFR-SE-19 and FR-AU-87: the file holds an address and may hold a single-use link.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('writes two messages as two files', async () => {
    const { sendEmail } = await load();
    await sendEmail({ to: 'a@example.com', subject: 'One', text: 'First.' });
    await sendEmail({ to: 'b@example.com', subject: 'Two', text: 'Second.' });
    expect(files()).toHaveLength(2);
  });

  it('names a file by neither the address nor the subject', async () => {
    const { sendEmail } = await load();
    await sendEmail({ to: 'someone.private@example.com', subject: 'Confidential subject', text: 'Body.' });
    const [name] = files();
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f-]{36}\.eml$/);
    expect(name!.toLowerCase()).not.toContain('someone');
    expect(name!.toLowerCase()).not.toContain('confidential');
  });

  it.each([
    ['to', { to: 'a@example.com\nBcc: x@example.com', subject: 'S', text: 'T' }],
    ['to', { to: 'a@example.com\r\nBcc: x@example.com', subject: 'S', text: 'T' }],
    ['subject', { to: 'a@example.com', subject: 'S\r\nBcc: x@example.com', text: 'T' }],
    ['subject', { to: 'a@example.com', subject: 'S\nBcc: x@example.com', text: 'T' }],
    ['subject', { to: 'a@example.com', subject: 'S\rBcc: x@example.com', text: 'T' }],
  ])('refuses a line break in %s, writes nothing, and does not repeat the value', async (_field, message) => {
    const { sendEmail } = await load();
    const error = await sendEmail(message).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).not.toContain('example.com');
    expect(error!.message).not.toContain('Bcc');
    expect(() => readdirSync(sink)).toThrow(); // not even the directory was made
  });

  it('writes nothing to the console, and a failure does not hold the message', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const { sendEmail } = await load();
    await sendEmail({
      to: 'reader@example.com',
      subject: 'A subject',
      text: 'https://example.com/link/secret',
    });

    // Make the write fail: the sink directory path is a file's child.
    process.env.EMAIL_SINK_DIRECTORY = join(sink, readdirSync(sink)[0]!, 'inside');
    const failing = await load();
    const error = await failing
      .sendEmail({ to: 'reader@example.com', subject: 'A subject', text: 'https://example.com/link/secret' })
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    expect(error).toBeInstanceOf(Error);
    for (const held of ['reader@example.com', 'A subject', 'secret'])
      expect(error!.message).not.toContain(held);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
