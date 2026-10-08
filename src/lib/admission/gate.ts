// What stands in front of each admission endpoint (FR-AU-89; NFR-SE-05 (b),
// NFR-SE-07, NFR-SE-19), in the order of docs/contracts/admission-signature.md:
// the signature is verified before any processing; only a verified request is
// counted against the limit; only then is the body read.
//
// The proxy passes these paths untouched (src/proxy.ts, group (b)), so this is
// the whole of their authentication and of their limit.
import { createHmac } from 'node:crypto';
import { faultOf } from '../fault.ts';
import { errorResponse } from '../http.ts';
import { securityLog } from '../security-log.ts';
import { takeLimit } from '../rate-limit.ts';
import { settings } from '../settings.ts';
import { valkey } from '../valkey.ts';
import { verifyRequest } from './signature.ts';

// Text for the person who runs the command (the owner's answer to Q6 of the
// plan). The first says nothing of which check failed.
const MESSAGES = {
  unauthorised:
    'This request was not accepted as a signed admission request. Check the admission secret and the clock of the caller, then send it again.',
  rateLimited: (seconds: number) =>
    `Too many requests were made in a short time. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
  internal:
    'The request could not be completed because of a fault on the server. Try again in a few minutes.',
};

// NFR-SE-19 asks for an entry where a signature does not verify. These paths
// are open to anyone and a rejected request is under no limit, so an entry for
// each would let a flood write to the database without bound. As the proxy
// does for a limit that is reached: one entry for each minute in which a
// request was rejected. An entry holds no detail, so nothing is lost but the count.
const LOG_PERIOD_SECONDS = 60;

// When this process last wrote the entry of a mark without Valkey's word.
const loggedWithoutValkey = new Map<string, number>();

async function once(mark: string, seconds: number): Promise<boolean> {
  try {
    // Keyed as the counters of the limits are, so that two environments on one
    // Valkey do not share a mark.
    const digest = createHmac('sha256', settings().authSecret).update(`admission:${mark}`).digest('hex');
    return (await valkey().set(`limit-logged:${digest}`, '1', 'EX', seconds, 'NX')) === 'OK';
  } catch {
    // Without Valkey the entry is still written, a log too full and never one
    // too empty, but the bound holds: one entry for each period from each
    // process, by this process's own clock, and not one for each request.
    const now = Date.now();
    if (now - (loggedWithoutValkey.get(mark) ?? -Infinity) < seconds * 1000) return false;
    loggedWithoutValkey.set(mark, now);
    return true;
  }
}

/**
 * Runs `handle` with the bytes of the body, for a request whose signature
 * verifies and that is within the limit. Every other request is answered here.
 */
export async function admission(
  request: Request,
  handle: (body: Uint8Array) => Promise<Response>,
): Promise<Response> {
  try {
    const body = await verifyRequest(request, settings().admissionSecret);
    if (!body) {
      if (await once('signature_invalid', LOG_PERIOD_SECONDS))
        await securityLog({ kind: 'signature_invalid' });
      return errorResponse(401, 'unauthorised', MESSAGES.unauthorised);
    }
    // 60 in any minute, in all: one counter for the three endpoints. A request
    // rejected above never reaches it, so nobody without the secret can use it up.
    const limit = await takeLimit('ADMISSION', 'all');
    if (!limit.ok) {
      if (await once('admission_limit', limit.retryAfterSeconds)) {
        await securityLog({ kind: 'rate_limit_reached' });
      }
      return errorResponse(429, 'rate_limited', MESSAGES.rateLimited(limit.retryAfterSeconds), {
        'Retry-After': String(limit.retryAfterSeconds),
      });
    }
    return await handle(body);
  } catch (error) {
    // NFR-SE-06, A10: refused, with nothing of the fault. NFR-SE-19: its class
    // and its code, since a database error can quote the row, which holds an address.
    console.error(`admission: request failed (${faultOf(error)})`);
    return errorResponse(500, 'internal', MESSAGES.internal);
  }
}
