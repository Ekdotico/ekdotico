// A Valkey that accepts the connection and refuses the subscription, as a
// managed one does whose ACL lacks the channel (`NOPERM`): how often the
// subscriber of src/lib/collab/events.ts asks, and what it prints (FR-ED-40,
// NFR-SE-19), and what the health check of the collaboration server answers
// meanwhile. The server here is a fake that speaks enough of the protocol
// for the client to become ready; the real Valkey is not touched.
import { spawn } from 'node:child_process';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, expect, it, vi } from 'vitest';
import { prepare } from './identity.ts';

// What the reply says after its code word: it names a user, and no line may hold it.
const REST = 'the user someone@example.com has no permissions to access one of the channels';
let refusing = true;
const asked = { SUBSCRIBE: 0 };
const peers = new Set<Socket>();

function serve(socket: Socket) {
  peers.add(socket);
  let buffer = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('close', () => peers.delete(socket));
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      // One command: an array of bulk strings.
      if (buffer[0] !== 0x2a) return;
      let at = buffer.indexOf('\r\n');
      if (at < 0) return;
      const count = Number(buffer.subarray(1, at).toString());
      at += 2;
      const parts: string[] = [];
      for (let index = 0; index < count; index++) {
        const end = buffer.indexOf('\r\n', at);
        if (end < 0) return;
        const length = Number(buffer.subarray(at + 1, end).toString());
        if (buffer.length < end + 2 + length + 2) return;
        parts.push(buffer.subarray(end + 2, end + 2 + length).toString());
        at = end + 2 + length + 2;
      }
      buffer = buffer.subarray(at);
      const name = parts[0]!.toUpperCase();
      if (name === 'INFO') {
        const body = 'redis_version:7.2.4\r\nloading:0\r\n';
        socket.write(`$${body.length}\r\n${body}\r\n`);
      } else if (name === 'SUBSCRIBE') {
        asked.SUBSCRIBE += 1;
        socket.write(
          refusing
            ? `-NOPERM ${REST}\r\n`
            : `*3\r\n$9\r\nsubscribe\r\n$${parts[1]!.length}\r\n${parts[1]}\r\n:1\r\n`,
        );
      } else {
        socket.write('+OK\r\n');
      }
    }
  });
}

const fake = createServer(serve);
await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
const database = prepare('subscribe', {
  VALKEY_URL: `redis://127.0.0.1:${(fake.address() as AddressInfo).port}`,
});
const { subscribeCollabEvents, subscribeRetryDelay } = await import('../../src/lib/collab/events.ts');

afterAll(async () => {
  for (const peer of peers) peer.destroy();
  await new Promise((resolve) => fake.close(resolve));
  database.drop();
});

it('waits 1 second after the first refusal, twice as long after each, and never more than 30', () => {
  expect([1, 2, 3, 4, 5, 6, 7, 40].map(subscribeRetryDelay)).toEqual([
    1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
  ]);
});

it(
  'asks a Valkey that refuses the subscription a handful of times in 10 seconds, prints one line, and subscribes when it may',
  { timeout: 40_000 },
  async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const subscription = subscribeCollabEvents(() => {});
    let subscribed = false;
    void subscription.subscribed.then(() => (subscribed = true));
    try {
      await sleep(10_000);
      // At 0, 1, 3 and 7 seconds, and the moments a reconnection takes: not
      // the 67 of a client that drops the connection at once.
      expect(asked.SUBSCRIBE).toBeGreaterThanOrEqual(3);
      expect(asked.SUBSCRIBE).toBeLessThanOrEqual(5);
      expect(subscribed).toBe(false);
      // One line for the state, not one for each attempt: the class of the
      // fault and the code word of the reply, and nothing of the rest of it.
      expect(errors.mock.calls).toEqual([['collab events: not subscribed (ReplyError NOPERM)']]);

      // The ACL is corrected: the next attempt subscribes, and says so once.
      refusing = false;
      await vi.waitFor(() => expect(subscribed).toBe(true), { timeout: 20_000, interval: 50 });
      expect(errors.mock.calls).toEqual([
        ['collab events: not subscribed (ReplyError NOPERM)'],
        ['collab events: subscribed again'],
      ]);
      // And the waits begin again from 1 second, should it be refused once more.
      refusing = true;
      const before = asked.SUBSCRIBE;
      subscription.client.stream.destroy();
      await vi.waitFor(() => expect(asked.SUBSCRIBE).toBe(before + 1), { timeout: 5000, interval: 20 });
      await sleep(1500);
      expect(asked.SUBSCRIBE).toBe(before + 2);
      // The lost connection may have a line of its own, which is the client's.
      expect(errors.mock.calls.filter(([line]) => String(line).startsWith('collab events:'))).toEqual([
        ['collab events: not subscribed (ReplyError NOPERM)'],
        ['collab events: subscribed again'],
        ['collab events: not subscribed (ReplyError NOPERM)'],
      ]);
    } finally {
      subscription.client.disconnect();
    }
  },
);

// The owner's amendment to choice C20 of the plan (8 October 2026): an
// instance that cannot be told to close a connection is not up (FR-ED-40).
it(
  'answers its health check 200 while subscribed, an empty 503 while the subscription is lost, and 200 once subscribed again',
  { timeout: 30_000 },
  async () => {
    refusing = false;
    const child = spawn('node', ['src/collab/server.ts'], {
      env: { ...process.env, EMAIL_TRANSPORT: 'brevo', COLLAB_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      // It listens only once it is subscribed.
      const port = await new Promise<string>((resolve, reject) => {
        let stdout = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
          const match = /listening on (\d+)/.exec(stdout);
          if (match) resolve(match[1]!);
        });
        child.once('exit', () => reject(new Error(`the collaboration server did not start: ${stderr}`)));
      });
      const health = () => fetch(`http://127.0.0.1:${port}/collab/health`);
      const answersWith = (status: number) =>
        vi.waitFor(async () => expect((await health()).status).toBe(status), {
          timeout: 10_000,
          interval: 50,
        });

      const up = await health();
      expect(up.status).toBe(200);
      expect(await up.text()).toBe('');

      // The connection is lost, and the Valkey it finds again refuses the channel.
      refusing = true;
      for (const peer of peers) peer.destroy();
      await answersWith(503);
      await vi.waitFor(() => expect(stderr).toContain('collab events: not subscribed (ReplyError NOPERM)'), {
        timeout: 10_000,
        interval: 50,
      });
      const down = await health();
      expect(down.status).toBe(503);
      expect(down.headers.get('cache-control')).toBe('no-store');
      expect(await down.text()).toBe('');
      // Nothing else it answers has changed.
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);

      refusing = false;
      await answersWith(200);
      expect(stderr).toContain('collab events: subscribed again');
    } finally {
      child.kill('SIGKILL');
    }
  },
);
