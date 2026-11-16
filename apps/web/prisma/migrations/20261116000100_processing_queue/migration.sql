-- AlterTable
ALTER TABLE "ProcessingJob" ADD COLUMN "idempotencyKey" VARCHAR(128);

-- CreateTable
CREATE TABLE "ProcessingJobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventType" VARCHAR(32) NOT NULL,
    "status" "ProcessingJobStatus",
    "stage" VARCHAR(64),
    "progress" INTEGER,
    "message" VARCHAR(512),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_id_workspaceId_key" ON "ProcessingJob"("id", "workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_workspaceId_idempotencyKey_key" ON "ProcessingJob"("workspaceId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "ProcessingJobEvent_workspaceId_jobId_createdAt_idx" ON "ProcessingJobEvent"("workspaceId", "jobId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProcessingJobEvent" ADD CONSTRAINT "ProcessingJobEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingJobEvent" ADD CONSTRAINT "ProcessingJobEvent_jobId_workspaceId_fkey" FOREIGN KEY ("jobId", "workspaceId") REFERENCES "ProcessingJob"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
