// The signature of an admission request (FR-AU-89, NFR-SE-05 (b)).
//
// PROVISIONAL. Praktico owns this contract. The suite owner decided on
// 8 October 2026 that the wire format belongs to Praktico's specification,
// which does not contain it yet (register Q25). Until it does, the format is
// the one recorded in docs/contracts/admission-signature.md, and this module
// follows that page line for line. When Praktico's specification states a
// format, that statement replaces the page and this module changes to match.
//
// Everything that depends on the format is here, with its tests in
// tests/unit/admission-signature.test.ts: the names of the two headers, the
// signed message, the limits on the form of each part, and the order of
// verification. Nothing else in the application may know any of them.
//
// The command (scripts/admission.ts) signs with this module under plain Node,
// so it imports nothing but the platform: no settings, no database.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TIMESTAMP_HEADER = 'X-Ekdotico-Timestamp';
export const SIGNATURE_HEADER = 'X-Ekdotico-Signature';

/** The path of create and list; revoke adds `/<id>`. */
export const INVITATIONS_PATH = '/api/admission/invitations';

/** "The body": at most 4,096 bytes. */
export const MAX_BODY_BYTES = 4096;
/** "Verification, in order", step 2: at most 300 seconds either way. */
const MAX_SKEW_SECONDS = 300;

const TIMESTAMP = /^[1-9][0-9]{9}$/;
// Upper-case hexadecimal is rejected, not folded.
const SIGNATURE = /^[0-9a-f]{64}$/;
const METHODS = ['POST', 'GET', 'DELETE'];
// The request target, whole: no query string, no trailing slash, no percent-encoding.
const TARGET = /^\/api\/admission\/invitations(\/[A-Za-z0-9_-]{1,64})?$/;

/**
 * HMAC-SHA-256 over `<timestamp>\n<METHOD>\n<path>\n` and then the bytes of the
 * body, unchanged. The key is the secret exactly as set, as UTF-8 bytes.
 */
function mac(secret: string, timestamp: string, method: string, path: string, body: Uint8Array): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(`${timestamp}\n${method}\n${path}\n`, 'utf8')
    .update(body)
    .digest();
}

/** The signature of a request, as 64 lower-case hexadecimal digits. */
export function sign(
  secret: string,
  timestamp: string,
  method: string,
  path: string,
  body: Uint8Array = new Uint8Array(),
): string {
  return mac(secret, timestamp, method, path, body).toString('hex');
}

/** The two headers of a request made now. The caller signs the bytes it sends. */
export function signedHeaders(
  secret: string,
  method: string,
  path: string,
  body: Uint8Array = new Uint8Array(),
  now: number = Date.now(),
): Record<string, string> {
  const timestamp = String(Math.floor(now / 1000));
  return { [TIMESTAMP_HEADER]: timestamp, [SIGNATURE_HEADER]: sign(secret, timestamp, method, path, body) };
}

export interface SignedParts {
  method: string;
  /** The request target as received: the path, and the query string where there is one. */
  target: string;
  /** The value of each header, or null. `Headers.get` joins a repeated header with ", ", which no pattern admits. */
  timestamp: string | null;
  signature: string | null;
  /** The bytes received, never decoded and never written out again. */
  body: Uint8Array;
}

/**
 * "Verification, in order", steps 1 to 3. True only where all three hold.
 * Without a secret nothing verifies, so every request is refused.
 */
export function verify(secret: string | undefined, parts: SignedParts, now: number = Date.now()): boolean {
  const { method, target, timestamp, signature, body } = parts;
  // 1. The form of each part.
  if (!secret || timestamp === null || signature === null) return false;
  if (!TIMESTAMP.test(timestamp) || !SIGNATURE.test(signature)) return false;
  if (!METHODS.includes(method) || !TARGET.test(target) || body.byteLength > MAX_BODY_BYTES) return false;
  // 2. The time, in whole seconds.
  if (!(Math.abs(Math.floor(now / 1000) - Number(timestamp)) <= MAX_SKEW_SECONDS)) return false;
  // 3. The signature, as 32 bytes, in constant time.
  return timingSafeEqual(mac(secret, timestamp, method, target, body), Buffer.from(signature, 'hex'));
}

// Reads at most `MAX_BODY_BYTES` of a body and gives up on one that is longer,
// so that a request nobody signed cannot make the application hold what it sent.
async function boundedBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

/**
 * Verifies a request as it was received. Returns the bytes of its body where
 * the signature verifies, and null otherwise, with nothing that says which
 * check failed. The body is read as JSON by the caller only after this.
 */
export async function verifyRequest(
  request: Request,
  secret: string | undefined,
  now: number = Date.now(),
): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) return null;
  const body = await boundedBody(request);
  if (!body) return null;
  // The target is what follows the origin, so a query string, even an empty
  // one, is part of it and fails the pattern.
  const url = new URL(request.url);
  const target = request.url.startsWith(url.origin) ? request.url.slice(url.origin.length) : '';
  const parts = {
    method: request.method,
    target,
    timestamp: request.headers.get(TIMESTAMP_HEADER),
    signature: request.headers.get(SIGNATURE_HEADER),
    body,
  };
  return verify(secret, parts, now) ? body : null;
}
