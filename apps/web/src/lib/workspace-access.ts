import { WorkspaceRole } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
export { canManageWorkspaceContent } from "@/lib/workspace-permissions";

export async function getWorkspaceRole(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId, userId },
    },
    select: { role: true },
  });

  return membership?.role ?? null;
}
