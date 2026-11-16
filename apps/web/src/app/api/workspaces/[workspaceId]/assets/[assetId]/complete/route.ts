import { auth } from "@/auth";
import { AssetStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  canManageWorkspaceContent,
  getWorkspaceRole,
} from "@/lib/workspace-access";
import {
  deleteStoredObject,
  getStoredObjectMetadata,
  storageErrorResponse,
} from "@/lib/storage";
import { hasSameOrigin } from "@/lib/request-security";
import { assetCompleteResponseSchema } from "@/lib/upload-schemas";

type RouteContext = {
  params: Promise<{ workspaceId: string; assetId: string }>;
};

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

  const { workspaceId, assetId } = await params;
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!canManageWorkspaceContent(role)) {
    return Response.json({ error: "Asset not found." }, { status: 404 });
  }

  const asset = await prisma.sourceAsset.findFirst({
    where: { id: assetId, workspaceId },
  });
  if (!asset) {
    return Response.json({ error: "Asset not found." }, { status: 404 });
  }
  if (asset.status === AssetStatus.READY) {
    const response = assetCompleteResponseSchema.parse({
      asset: {
        id: asset.id,
        projectId: asset.projectId,
        originalFilename: asset.originalFilename,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes.toString(),
        status: asset.status,
        createdAt: asset.createdAt.toISOString(),
      },
    });
    return Response.json(response);
  }
  if (asset.status !== AssetStatus.UPLOADING) {
    return Response.json({ error: "Asset is not awaiting upload." }, { status: 409 });
  }

  let storedObject: Awaited<ReturnType<typeof getStoredObjectMetadata>>;
  try {
    storedObject = await getStoredObjectMetadata(asset.storageKey);
  } catch (error) {
    const response = storageErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
  if (!storedObject) {
    return Response.json({ error: "Uploaded video was not found." }, { status: 409 });
  }

  if (
    storedObject.sizeBytes !== Number(asset.sizeBytes) ||
    storedObject.mimeType !== asset.mimeType
  ) {
    await prisma.sourceAsset.update({
      where: { id: asset.id },
      data: { status: AssetStatus.FAILED },
    });
    try {
      await deleteStoredObject(asset.storageKey);
    } catch (error) {
      const response = storageErrorResponse(error);
      if (response) {
        return response;
      }
      throw error;
    }
    return Response.json(
      { error: "Uploaded video does not match the declared file details." },
      { status: 422 },
    );
  }

  const updated = await prisma.sourceAsset.update({
    where: { id: asset.id },
    data: { status: AssetStatus.READY },
  });
  const response = assetCompleteResponseSchema.parse({
    asset: {
      id: updated.id,
      projectId: updated.projectId,
      originalFilename: updated.originalFilename,
      mimeType: updated.mimeType,
      sizeBytes: updated.sizeBytes.toString(),
      status: updated.status,
      createdAt: updated.createdAt.toISOString(),
    },
  });
  return Response.json(response, { headers: { "Cache-Control": "no-store" } });
}
