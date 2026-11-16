import { randomUUID } from "node:crypto";
import { WorkspaceRole } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { WorkspaceSummary } from "@/lib/workspace-schemas";

function slugBase(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);

  return slug || "workspace";
}

async function createWorkspace(
  userId: string,
  name: string,
): Promise<WorkspaceSummary> {
  const workspace = await prisma.$transaction(async (transaction) => {
    const created = await transaction.workspace.create({
      data: {
        name,
        slug: `${slugBase(name)}-${randomUUID().slice(0, 8)}`,
      },
    });

    await transaction.workspaceMember.create({
      data: {
        workspaceId: created.id,
        userId,
        role: WorkspaceRole.OWNER,
      },
    });

    return created;
  });

  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    role: WorkspaceRole.OWNER,
  };
}

export async function createPersonalWorkspace(
  userId: string,
  name: string,
): Promise<WorkspaceSummary> {
  return createWorkspace(userId, name);
}

export async function createTeamWorkspace(
  userId: string,
  name: string,
): Promise<WorkspaceSummary> {
  return createWorkspace(userId, name);
}

export async function listUserWorkspaces(
  userId: string,
): Promise<WorkspaceSummary[]> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId },
    select: {
      role: true,
      workspace: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  return memberships.map(({ role, workspace }) => ({
    ...workspace,
    role,
  }));
}
