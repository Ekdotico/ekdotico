// The single use of a signed admission request (FR-AU-89; register D299, Q82 point 4; docs@da33e58): "the application
// keeps each nonce it has accepted until the time the request carries is more than 5 minutes in the past, and rejects
// before any processing a request whose nonce it holds". "A nonce is recorded only after the signature and the time
// verify, by one atomic insert under a unique constraint, so that of two copies of a request sent at the same moment
// exactly one is accepted, and the nonces are kept in the application's database, shared by every instance and kept
// across a restart."
//
// PROVISIONAL, as the rest of the wire format (./signature.ts, docs/contracts/admission-signature.md): the field that
// carries the nonce is Praktico's to settle. This module knows only the nonce and the signed time, and the table that
// holds them (`AdmissionNonce`, which carries no personal field).
import { db } from '../db.ts';

const SKEW_SECONDS = 300;

/**
 * Records the nonce of a request whose signature and time verified, and says whether this request is the first to
 * carry it. One `INSERT … ON CONFLICT DO NOTHING` on the primary key: the database decides between two copies sent
 * at one moment, whichever instance each reaches, and a restart forgets nothing. The row is kept until the signed
 * time is more than 5 minutes in the past, and one second more, because a request is accepted while the whole
 * seconds of the application's clock differ from the signed time by 300 at most.
 */
export async function claimNonce(nonce: string, signedAtSeconds: number): Promise<boolean> {
  const { count } = await db().admissionNonce.createMany({
    data: [{ nonce, expiresAt: new Date((signedAtSeconds + SKEW_SECONDS + 1) * 1000) }],
    skipDuplicates: true,
  });
  return count === 1;
}

/** The nonces whose time has passed: a request that carried one is refused for its time whatever the nonce says. Answers with how many. */
export async function deleteExpiredNonces(now: Date = new Date()): Promise<number> {
  return (await db().admissionNonce.deleteMany({ where: { expiresAt: { lte: now } } })).count;
}
