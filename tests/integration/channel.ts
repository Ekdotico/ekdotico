// A listener on the channel the web application publishes to (FR-ED-40;
// NFR-SE-03 (d)), for the tests that look at what a change published: the
// messages it heard, byte for byte, and who they were about. The channel is
// shared by every run on a machine, so a test reads the messages about the
// accounts and documents of its own.
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';

export async function listen() {
  // Imported when called, after the test has set the environment.
  const { COLLAB_EVENTS_CHANNEL } = await import('../../src/lib/collab/events.ts');
  const heard: string[] = [];
  const subscriber = new Redis(process.env.VALKEY_URL!);
  subscriber.on('message', (_channel, message) => void heard.push(message));
  await subscriber.subscribe(COLLAB_EVENTS_CHANNEL);
  return {
    heard,
    /** The messages that name this identifier, in order. */
    about: (identifier: string) => heard.filter((message) => message.includes(identifier)),
    /** The messages that say a session of this user ended, as published. */
    sessionsEnded: (userId: string) =>
      heard.filter((message) => message === `{"kind":"session-ended","userId":"${userId}"}`),
    /** Waits a moment for a message that must not come. */
    quiet: () => sleep(250),
    stop: () => subscriber.disconnect(),
  };
}

/** Polls until `read` gives something, or fails after `within` milliseconds. */
export async function until<T>(read: () => T | Promise<T>, within = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + within;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${within} ms`);
    await sleep(20);
  }
}
