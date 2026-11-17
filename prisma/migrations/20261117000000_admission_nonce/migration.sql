-- FR-AU-89, register D299 and Q82 point 4 (docs@da33e58): a signed admission request is single-use. The nonce of each
-- accepted request is inserted under the primary key, so that of two copies exactly one is accepted, and is kept until
-- the signed time is more than 5 minutes in the past. No personal field.
CREATE TABLE "AdmissionNonce" (
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdmissionNonce_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "AdmissionNonce_expiresAt_idx" ON "AdmissionNonce"("expiresAt");
