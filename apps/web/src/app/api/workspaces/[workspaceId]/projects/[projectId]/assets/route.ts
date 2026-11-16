import { randomUUID } from "node:crypto";
import { auth } from "@/auth";
import { AssetStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  canManageWorkspaceContent,
  getWorkspaceRole,
} from "@/lib/workspace-access";
import { createUploadForm, storageErrorResponse } from "@/lib/storage";
import { hasSameOrigin } from "@/lib/request-security";
import {
  uploadInitResponseSchema,
  uploadInitSchema,
} from "@/lib/upload-schemas";

const MAX_UPLOAD_BYTES = 5_000_000_000;

type RouteContext = {
  params: Promise<{ workspaceId: string; projectId: string }>;
};

function configuredUploadLimit(): number {
  const limit = Number(process.env.MAX_UPLOAD_BYTES ?? "1073741824");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_UPLOAD_BYTES) {
    throw new Error("MAX_UPLOAD_BYTES must be an integer from 1 to 5,000,000,000.");
  }
  return limit;
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

  const { workspaceId, projectId } = await params;
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!canManageWorkspaceContent(role)) {
    return Response.json({ error: "Project not found." }, { status: 404 });
  }

  const project = await prisma.project.findFirst({
    where: { id: projectId, workspaceId },
    select: { id: true },
  });
  if (!project) {
    return Response.json({ error: "Project not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = uploadInitSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Provide a supported video file name, type, and size." },
      { status: 400 },
    );
  }
  if (parsed.data.sizeBytes > configuredUploadLimit()) {
    return Response.json(
      { error: "Video exceeds the configured upload limit." },
      { status: 413 },
    );
  }

  const assetId = randomUUID();
  const storageKey = `${workspaceId}/${assetId}/source`;
  let form: Awaited<ReturnType<typeof createUploadForm>>;
  try {
    form = await createUploadForm(
      storageKey,
      parsed.data.mimeType,
      parsed.data.sizeBytes,
    );
  } catch (error) {
    const response = storageErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }

  const asset = await prisma.sourceAsset.create({
    data: {
      id: assetId,
      workspaceId,
      projectId,
      originalFilename: parsed.data.fileName,
      storageKey,
      mimeType: parsed.data.mimeType,
      sizeBytes: BigInt(parsed.data.sizeBytes),
      status: AssetStatus.UPLOADING,
    },
    select: { id: true },
  });

  const response = uploadInitResponseSchema.parse({
    assetId: asset.id,
    uploadUrl: form.url,
    fields: form.fields,
    expiresAt: new Date(Date.now() + form.expiresIn * 1000).toISOString(),
  });
  return Response.json(response, {
    status: 201,
    headers: { "Cache-Control": "no-store" },
  });
}
