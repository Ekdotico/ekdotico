// The collaboration server of the end-to-end tests: the real process, `node
// src/collab/server.ts`, with the database, Valkey and secret of the web
// application the tests drive (playwright.config.ts). A test starts and stops
// it, which is how a lost connection is made; the page reaches it on the
// application's own origin, through the development rewrite of next.config.ts.
//
// And a client that is no browser: the provider over Node's WebSocket, with a
// session's cookie, which writes into a document what no editor would.
import { spawn, type ChildProcess } from 'node:child_process';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { BrowserContext } from '@playwright/test';
import { COLLAB_PATH } from '../../src/lib/collab/protocol.ts';
import { APP_ORIGIN, AUTH_SECRET, COLLAB_PORT } from './origin.ts';

let running: ChildProcess | undefined;

export async function startCollab(): Promise<void> {
  if (running) return;
  const child = spawn('node', ['src/collab/server.ts'], {
    env: {
      ...process.env,
      FOUNDING_TEAM_EMAILS: '',
      APP_ORIGIN,
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      VALKEY_URL: process.env.VALKEY_URL ?? 'redis://localhost:6379',
      AUTH_SECRET,
      COLLAB_PORT,
      // FR-ED-41: the re-check, 60 seconds where unset; a test of a role that changes would wait that long.
      COLLAB_RECHECK_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  running = child;
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk) => {
      if (String(chunk).includes('listening on')) resolve();
    });
    child.once('exit', () => reject(new Error('the collaboration server did not start')));
  });
}

/** The orderly stop: every open document is stored, and every socket closed (NFR-RE-07). */
export async function stopCollab(): Promise<void> {
  const child = running;
  if (!child) return;
  running = undefined;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

/**
 * A connection to one document as the account signed in to `context`, made
 * straight to the collaboration server with the headers a browser sends.
 * Resolves with the provider once the document is synchronised, or rejects
 * with the reason of the refusal.
 */
export async function connectAs(context: BrowserContext, documentId: string) {
  const cookie = (await context.cookies()).map(({ name, value }) => `${name}=${value}`).join('; ');
  class Socket extends WebSocket {
    constructor(url: string | URL) {
      super(url, { headers: { cookie, origin: APP_ORIGIN } } as never);
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${COLLAB_PORT}${COLLAB_PATH}`,
    WebSocketPolyfill: Socket,
  });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: documentId, awareness: null });
  const close = () => {
    provider.destroy();
    socket.destroy();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      provider.on('synced', () => resolve());
      provider.on('authenticationFailed', ({ reason }: { reason: string }) => reject(new Error(reason)));
      // A handshake refused as a whole: no socket was ever opened.
      socket.on('disconnect', () => reject(new Error('handshake refused')));
      provider.attach();
    });
  } catch (error) {
    close();
    throw error;
  }
  return { provider, close };
}
