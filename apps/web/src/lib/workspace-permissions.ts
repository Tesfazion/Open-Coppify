import { WorkspaceRole } from "@/generated/prisma/client";

const CONTENT_ROLES = new Set<WorkspaceRole>([
  WorkspaceRole.OWNER,
  WorkspaceRole.ADMIN,
  WorkspaceRole.EDITOR,
]);

export function canManageWorkspaceContent(
  role: WorkspaceRole | null,
): boolean {
  return role !== null && CONTENT_ROLES.has(role);
}
