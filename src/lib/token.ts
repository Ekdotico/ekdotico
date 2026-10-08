// The token of a single-use link: an admission invitation (FR-AU-89) and a
// password reset (FR-AU-86) today. Each requirement asks for a token that is
// stored only as a hash.
import { createHash, randomBytes } from 'node:crypto';

// 256 bits from the platform's cryptographic source (the requirements ask for
// 128 or more), written in the URL-safe alphabet: 43 characters, which is what
// the allow-list of proxy.ts takes a `[token]` to be made of.
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const newToken = () => randomBytes(32).toString('base64url');

// Stored only as this hash. A plain SHA-256 is sound here, where it would not
// be for a password: the token is 256 random bits, so there is nothing to
// guess and nothing a salt or a slow function would add. The row is found by
// the hash, through an index; no comparison of secrets is made in code.
export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
