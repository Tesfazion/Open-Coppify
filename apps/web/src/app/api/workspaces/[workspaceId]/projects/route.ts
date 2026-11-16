import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { hasSameOrigin } from "@/lib/request-security";
import {
  createProjectSchema,
  projectCreateResponseSchema,
  projectListResponseSchema,
} from "@/lib/project-schemas";
import {
  canManageWorkspaceContent,
  getWorkspaceRole,
} from "@/lib/workspace-access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
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

  const { workspaceId } = await params;
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!role) {
    return Response.json({ error: "Workspace not found." }, { status: 404 });
  }

  const projects = await prisma.project.findMany({
    where: { workspaceId },
    select: { id: true, name: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const response = projectListResponseSchema.parse({
    projects: projects.map((project) => ({
      ...project,
      createdAt: project.createdAt.toISOString(),
    })),
  });
  return Response.json(response);
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

  const { workspaceId } = await params;
  const role = await getWorkspaceRole(userId, workspaceId);
  if (!canManageWorkspaceContent(role)) {
    return Response.json({ error: "Workspace not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Project name must be between 2 and 120 characters." },
      { status: 400 },
    );
  }

  const project = await prisma.project.create({
    data: { workspaceId, name: parsed.data.name },
    select: { id: true, name: true, createdAt: true },
  });
  const response = projectCreateResponseSchema.parse({
    project: { ...project, createdAt: project.createdAt.toISOString() },
  });
  return Response.json(response, { status: 201 });
}
