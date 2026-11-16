import { auth } from "@/auth";
import { AssetStatus } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { createDownloadUrl, storageErrorResponse } from "@/lib/storage";
import { getWorkspaceRole } from "@/lib/workspace-access";

type RouteContext = {
  params: Promise<{ workspaceId: string; assetId: string }>;
};

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const { workspaceId, assetId } = await params;
  if (!(await getWorkspaceRole(userId, workspaceId))) {
    return Response.json({ error: "Asset not found." }, { status: 404 });
  }

  const asset = await prisma.sourceAsset.findFirst({
    where: { id: assetId, workspaceId, status: AssetStatus.READY },
    select: {
      storageKey: true,
      mimeType: true,
      originalFilename: true,
    },
  });
  if (!asset) {
    return Response.json({ error: "Asset not found." }, { status: 404 });
  }

  let url: string;
  try {
    url = await createDownloadUrl(
      asset.storageKey,
      asset.mimeType,
      asset.originalFilename,
    );
  } catch (error) {
    const response = storageErrorResponse(error);
    if (response) {
      return response;
    }
    throw error;
  }
  return Response.json(
    { url },
    { headers: { "Cache-Control": "no-store" } },
  );
}
