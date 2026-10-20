-- CreateTable
CREATE TABLE "DocumentImage" (
    "id" TEXT NOT NULL,
    "documentId" UUID NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unreferencedAt" TIMESTAMP(3),
    "deletionClaimedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentImage_objectKey_key" ON "DocumentImage"("objectKey");

-- CreateIndex
CREATE INDEX "DocumentImage_documentId_idx" ON "DocumentImage"("documentId");

-- AddForeignKey
ALTER TABLE "DocumentImage" ADD CONSTRAINT "DocumentImage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What follows is written by hand: the schema file cannot say it.

-- NFR-SE-18, FR-ED-08: an image is one of four types, and 20 MB or less (20 x 1,024 x 1,024
-- bytes). A backstop under the route, which establishes both from the content.
ALTER TABLE "DocumentImage" ADD CONSTRAINT "DocumentImage_type_check"
  CHECK ("contentType" IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp'));
ALTER TABLE "DocumentImage" ADD CONSTRAINT "DocumentImage_size_check"
  CHECK ("byteSize" > 0 AND "byteSize" <= 20971520);
