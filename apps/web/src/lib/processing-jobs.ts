import { prisma } from "@/lib/db";
import { processingJobResponseSchema } from "@/lib/processing-job-schemas";

export async function getProcessingJobResponse(
  workspaceId: string,
  jobId: string,
) {
  const job = await prisma.processingJob.findFirst({
    where: { id: jobId, workspaceId },
    select: {
      id: true,
      projectId: true,
      sourceAssetId: true,
      status: true,
      stage: true,
      progress: true,
      errorCode: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
      events: {
        select: {
          id: true,
          eventType: true,
          status: true,
          stage: true,
          progress: true,
          message: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      },
    },
  });
  if (!job) {
    return null;
  }

  return processingJobResponseSchema.parse({
    job: {
      id: job.id,
      projectId: job.projectId,
      sourceAssetId: job.sourceAssetId,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    },
    events: job.events
      .reverse()
      .map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
  });
}
