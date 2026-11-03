// The harness of procedure 1 (docs/plan/slice-27.md, S27-8) against the real collaboration server: ten connections
// to one document, a typist, and the time each change took to arrive at nine receivers. The browser typist
// (scripts/measure/browser.ts) is not run here; the connection typist shares everything else with it.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import referenceDocument from '../fixtures/reference-document.json' with { type: 'json' };
import {
  connect,
  connectionTypist,
  FRAGMENT,
  fillFragment,
  measure,
  Receiver,
  tailLength,
  type Connection,
} from '../../scripts/measure/harness.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('measure');
const { auth, db } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');

let server: ChildProcess;
let url = '';
let documentId = '';
const cookies: string[] = [];
const work = mkdtempSync(join(tmpdir(), 'ekdotico-measure-'));
const open: Connection[] = [];

beforeAll(async () => {
  server = spawn('node', ['src/collab/server.ts'], {
    env: { ...process.env, EMAIL_TRANSPORT: 'brevo', COLLAB_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    server.stdout!.on('data', (chunk) => {
      out += chunk;
      const match = /listening on (\d+)/.exec(out);
      if (match) resolve(Number(match[1]));
    });
    server.once('exit', () => reject(new Error('the collaboration server did not start')));
  });
  url = `ws://127.0.0.1:${port}/collab`;
  // Ten accounts: the Owner, and nine Editors (the limit of a document is ten connections).
  const emails = Array.from({ length: 10 }, (_, at) => `measure${at}@example.com`);
  const ids: string[] = [];
  for (const email of emails) {
    ids.push(await createAccount(auth, email));
    cookies.push(cookiesOf(await signIn(auth, email)));
  }
  documentId = (await createDocument(ids[0]!)).id;
  for (const id of ids.slice(1))
    await db().documentCollaborator.create({ data: { documentId, userId: id, role: 'EDITOR' } });
}, 120_000);

afterAll(async () => {
  for (const connection of open) connection.close();
  server?.kill('SIGKILL');
  await db().$disconnect();
  rmSync(work, { recursive: true, force: true });
  database.drop();
});

async function receiversOf(list: string[]): Promise<Receiver[]> {
  const receivers: Receiver[] = [];
  for (const cookie of list) {
    const connection = await connect(url, ORIGIN, cookie, documentId);
    open.push(connection);
    receivers.push(new Receiver(connection));
  }
  return receivers;
}

describe('the harness, against the real server', () => {
  it('holds ten connections to one document and measures each change at nine receivers', async () => {
    const typistConnection = await connect(url, ORIGIN, cookies[0]!, documentId);
    open.push(typistConnection);
    const fragment = typistConnection.document.getXmlFragment(FRAGMENT);
    typistConnection.document.transact(() => fillFragment(fragment, referenceDocument as never));
    await new Promise((resolve) => setTimeout(resolve, 500));

    const receivers = await receiversOf(cookies.slice(1));
    expect(receivers).toHaveLength(9);
    // Every receiver holds the reference document, and starts from the same paragraph.
    for (const receiver of receivers) {
      expect(receiver.connection.document.getXmlFragment(FRAGMENT).length).toBe(
        referenceDocument.content.length,
      );
      expect(receiver.base).toBe(tailLength(fragment));
    }
    const result = await measure({
      receivers,
      typist: connectionTypist(typistConnection),
      keystrokes: 80,
      rate: 40,
    });
    expect(result.connections).toBe(10);
    expect(result.propagationMissing).toBe(0);
    expect(result.propagation.n).toBe(80 * 9);
    expect(result.perReceiver).toHaveLength(9);
    // A change goes through the server on this machine in far less than a second; and a time is never negative.
    expect(result.propagation.p50).toBeGreaterThanOrEqual(0);
    expect(result.propagation.p99).toBeGreaterThanOrEqual(result.propagation.p50);
    expect(result.propagation.p99).toBeLessThan(1000);
    expect(result.keystroke).toBeNull();
    // The characters typed are the ones received, in order.
    for (const receiver of receivers) {
      expect(tailLength(receiver.connection.document.getXmlFragment(FRAGMENT))).toBe(receiver.base + 80);
    }
  }, 60_000);

  it('counts a change a receiver never saw, and does not call it fast', async () => {
    const typistConnection = open[0]!;
    // The ten of the first test are let go: a document holds ten connections.
    for (const connection of open.splice(1)) connection.close();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const receivers = await receiversOf(cookies.slice(1, 3));
    // A receiver that is cut off before the typist begins sees nothing of it.
    receivers[1]!.connection.close();
    const result = await measure({
      receivers: [receivers[0]!, receivers[1]!],
      typist: connectionTypist(typistConnection),
      keystrokes: 20,
      rate: 40,
    });
    expect(result.propagationMissing).toBe(20);
    expect(result.propagation.n).toBe(20);
  }, 30_000);
});

describe('the command', () => {
  it('seeds an empty document, runs without a browser, and prints no cookie', async () => {
    const fresh = (
      await createDocument(
        (await db().user.findUniqueOrThrow({ where: { email: 'measure0@example.com' } })).id,
      )
    ).id;
    const file = join(work, 'cookies.json');
    writeFileSync(file, JSON.stringify(cookies), { mode: 0o600 });
    const common = ['--origin', ORIGIN, '--collab-url', url, '--document', fresh, '--cookies', file];
    const run = (...args: string[]) =>
      spawnSync('node', ['scripts/measure-editor.ts', ...args, ...common], {
        encoding: 'utf8',
        env: { NODE_ENV: 'test', PATH: process.env.PATH! },
      });
    // Each Editor of the new document, as the procedure shares it.
    for (const email of Array.from({ length: 9 }, (_, at) => `measure${at + 1}@example.com`)) {
      const user = await db().user.findUniqueOrThrow({ where: { email } });
      await db().documentCollaborator.create({
        data: { documentId: fresh, userId: user.id, role: 'EDITOR' },
      });
    }
    const seeded = run('seed');
    expect(seeded.status, seeded.stderr).toBe(0);
    expect(seeded.stdout).toBe(`seed: wrote ${referenceDocument.content.length} blocks, 5000 words\n`);
    expect(run('seed').stderr).toMatch(/not empty/);

    const ran = run('run', '--no-browser', '--minutes', '0.05', '--rate', '20');
    expect(ran.stderr).not.toMatch(/measure:/);
    expect(ran.status).toBe(0);
    expect(ran.stdout).toContain('run: 10 connections held');
    expect(JSON.parse(ran.stdout.slice(ran.stdout.indexOf('{'))).typed).toBe(60);
    for (const cookie of cookies)
      expect(ran.stdout + ran.stderr).not.toContain(cookie.split('; ')[0]!.split('=')[1]!);
  }, 60_000);

  it('refuses a cookies file that others can read, and one of fewer than ten', () => {
    const file = join(work, 'open.json');
    writeFileSync(file, JSON.stringify(cookies));
    chmodSync(file, 0o644);
    const base = [
      'scripts/measure-editor.ts',
      'run',
      '--origin',
      ORIGIN,
      '--document',
      'x',
      '--cookies',
      file,
    ];
    expect(spawnSync('node', base, { encoding: 'utf8' }).stderr).toMatch(/readable by others/);
    chmodSync(file, 0o600);
    writeFileSync(file, JSON.stringify(cookies.slice(0, 3)));
    expect(spawnSync('node', base, { encoding: 'utf8' }).stderr).toMatch(/array of ten strings/);
  });
});

void Y;
