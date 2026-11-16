import { randomUUID } from "node:crypto";
import { auth } from "@/auth";
import {
  AssetStatus,
  ProcessingJobStatus,
  Prisma,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  getProcessingJobResponse,
} from "@/lib/processing-jobs";
import {
  enqueueProcessingJob,
  type ProcessingQueuePayload,
} from "@/lib/processing-queue";
import { hasSameOrigin } from "@/lib/request-security";
import {
  canManageWorkspaceContent,
  getWorkspaceRole,
} from "@/lib/workspace-access";
import { idempotencyKeySchema } from "@/lib/processing-job-schemas";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
    projectId: string;
    assetId: string;
  }>;
};

async function markQueueUnavailable(
  workspaceId: string,
  jobId: string,
): Promise<void> {
  await prisma.$transaction(async (transaction) => {
    const updated = await transaction.processingJob.updateMany({
      where: {
        id: jobId,
        workspaceId,
        status: ProcessingJobStatus.QUEUED,
        errorCode: null,
      },
      data: {
        status: ProcessingJobStatus.FAILED,
        errorCode: "QUEUE_UNAVAILABLE",
        errorMessage: "Processing could not be queued. Retry with a new request key.",
      },
    });
    if (updated.count > 0) {
      await transaction.processingJobEvent.create({
        data: {
          jobId,
          workspaceId,
          eventType: "queue_failed",
          status: ProcessingJobStatus.FAILED,
          message: "The processing queue is unavailable.",
        },
      });
    }
  });
}

async function enqueue(
  workspaceId: string,
  jobId: string,
  payload: ProcessingQueuePayload,
): Promise<boolean> {
  try {
    await enqueueProcessingJob(payload);
    return true;
  } catch (error) {
    console.error(
      "Could not enqueue processing job.",
      error instanceof Error ? error.name : "UnknownError",
    );
    await markQueueUnavailable(workspaceId, jobId);
    return false;
  }
}

export async function POST(
  request: Request,
  { params }: RouteContext,
): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const { workspaceId, projectId, assetId } = await params;
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!canManageWorkspaceContent(role)) {
    return Response.json({ error: "Asset not found." }, { status: 404 });
  }

  const idempotencyKey = idempotencyKeySchema.safeParse(
    request.headers.get("idempotency-key"),
  );
  if (!idempotencyKey.success) {
    return Response.json(
      { error: "Provide an Idempotency-Key header of 8 to 128 safe characters." },
      { status: 400 },
    );
  }

  const asset = await prisma.sourceAsset.findFirst({
    where: {
      id: assetId,
      projectId,
      workspaceId,
      status: AssetStatus.READY,
    },
    select: { id: true },
  });
  if (!asset) {
    return Response.json({ error: "Ready asset not found." }, { status: 404 });
  }

  let job = await prisma.processingJob.findUnique({
    where: {
      workspaceId_idempotencyKey: {
        workspaceId,
        idempotencyKey: idempotencyKey.data,
      },
    },
    select: { id: true, projectId: true, sourceAssetId: true, status: true },
  });

  if (job && (job.projectId !== projectId || job.sourceAssetId !== assetId)) {
    return Response.json(
      { error: "Idempotency-Key was already used for a different request." },
      { status: 409 },
    );
  }

  if (!job) {
    const jobId = randomUUID();
    try {
      await prisma.$transaction(async (transaction) => {
        await transaction.processingJob.create({
          data: {
            id: jobId,
            workspaceId,
            projectId,
            sourceAssetId: assetId,
            bullJobId: jobId,
            idempotencyKey: idempotencyKey.data,
            status: ProcessingJobStatus.QUEUED,
            stage: "queued",
            progress: 0,
          },
        });
        await transaction.processingJobEvent.create({
          data: {
            jobId,
            workspaceId,
            eventType: "queued",
            status: ProcessingJobStatus.QUEUED,
            stage: "queued",
            progress: 0,
            message: "Video processing was queued.",
          },
        });
      });
      job = {
        id: jobId,
        projectId,
        sourceAssetId: assetId,
        status: ProcessingJobStatus.QUEUED,
      };
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }
      job = await prisma.processingJob.findUnique({
        where: {
          workspaceId_idempotencyKey: {
            workspaceId,
            idempotencyKey: idempotencyKey.data,
          },
        },
        select: { id: true, projectId: true, sourceAssetId: true, status: true },
      });
      if (!job) {
        throw error;
      }
      if (job.projectId !== projectId || job.sourceAssetId !== assetId) {
        return Response.json(
          { error: "Idempotency-Key was already used for a different request." },
          { status: 409 },
        );
      }
    }
  }

  if (job.status === ProcessingJobStatus.QUEUED) {
    const queued = await enqueue(workspaceId, job.id, {
      processingJobId: job.id,
      workspaceId,
      projectId,
      sourceAssetId: assetId,
    });
    if (!queued) {
      const response = await getProcessingJobResponse(workspaceId, job.id);
      return Response.json(
        { error: "Processing queue is unavailable.", ...response },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  const response = await getProcessingJobResponse(workspaceId, job.id);
  if (!response) {
    throw new Error("Processing job disappeared after it was created.");
  }
  return Response.json(response, {
    status: job.status === ProcessingJobStatus.QUEUED ? 202 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
