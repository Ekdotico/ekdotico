-- CreateTable
CREATE TABLE "SecurityLogEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "documentId" UUID,

    CONSTRAINT "SecurityLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityLogEntry_createdAt_idx" ON "SecurityLogEntry"("createdAt");
