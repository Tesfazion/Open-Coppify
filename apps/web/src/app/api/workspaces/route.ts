import { auth } from "@/auth";
import { createTeamWorkspace, listUserWorkspaces } from "@/lib/workspaces";
import { hasSameOrigin } from "@/lib/request-security";
import {
  createWorkspaceSchema,
  workspaceListResponseSchema,
  workspaceCreateResponseSchema,
} from "@/lib/workspace-schemas";

export async function GET(): Promise<Response> {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  const workspaces = await listUserWorkspaces(userId);
  const response = workspaceListResponseSchema.parse({ workspaces });
  return Response.json(response);
}

export async function POST(request: Request): Promise<Response> {
  if (!hasSameOrigin(request)) {
    return Response.json({ error: "Cross-origin request rejected." }, { status: 403 });
  }

  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsed = createWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Workspace name must be between 2 and 80 characters." },
      { status: 400 },
    );
  }

  const workspace = await createTeamWorkspace(userId, parsed.data.name);
  const response = workspaceCreateResponseSchema.parse({ workspace });
  return Response.json(response, { status: 201 });
}
