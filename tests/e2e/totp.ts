// The code of an authenticator application (RFC 6238, with RFC 4226: six
// digits, a step of 30 seconds, HMAC-SHA-1), computed here as an application
// on a person's telephone computes it, from the secret the page shows, and
// from nothing of the code under test.
import { createHmac } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30_000;

/** The bytes of a secret that is written in base32 (RFC 4648), as a person types it in. */
function keyOf(secret: string): Buffer {
  const bits = [...secret.replace(/[\s=]/g, '').toUpperCase()]
    .map((letter) => ALPHABET.indexOf(letter).toString(2).padStart(5, '0'))
    .join('');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((eight) => parseInt(eight, 2)));
}

function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', keyOf(secret)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

const shown = new Map<string, Set<number>>();
/**
 * The code the authenticator shows for this secret, and one that no earlier
 * call gave: a code is accepted once. Where the code of this step and that of
 * the next were both given, it waits for a new step, as a person would.
 */
export async function freshCode(secret: string): Promise<string> {
  const given = shown.get(secret) ?? new Set<number>();
  shown.set(secret, given);
  for (;;) {
    const now = Math.floor(Date.now() / STEP_MS);
    const step = [now, now + 1].find((each) => !given.has(each));
    if (step !== undefined) {
      given.add(step);
      return codeAt(secret, step);
    }
    await pause(STEP_MS - (Date.now() % STEP_MS) + 50);
  }
}

/** Six digits that are not the code of this step nor of the two beside it. */
export function wrongCode(secret: string): string {
  const now = Math.floor(Date.now() / STEP_MS);
  const right = [-1, 0, 1, 2].map((steps) => codeAt(secret, now + steps));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, '0');
    if (!right.includes(code)) return code;
  }
}
