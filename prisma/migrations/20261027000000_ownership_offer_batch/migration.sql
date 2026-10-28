-- FR-AU-92 (docs/plan/slice-24.md, S24-5): the transfer of all documents that made an offer. Null for an offer made
-- one document at a time. It groups the one email to each person offered, and lists the documents of the action
-- that were accepted. No personal field.
ALTER TABLE "OwnershipOffer" ADD COLUMN "batchId" UUID;
