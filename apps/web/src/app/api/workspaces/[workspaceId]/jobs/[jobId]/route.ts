import { auth } from "@/auth";
import { getProcessingJobResponse } from "@/lib/processing-jobs";
import { getWorkspaceRole } from "@/lib/workspace-access";

type RouteContext = {
  params: Promise<{ workspaceId: string; jobId: string }>;
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

  const { workspaceId, jobId } = await params;
  if (!(await getWorkspaceRole(userId, workspaceId))) {
    return Response.json({ error: "Processing job not found." }, { status: 404 });
  }

  const response = await getProcessingJobResponse(workspaceId, jobId);
  if (!response) {
    return Response.json({ error: "Processing job not found." }, { status: 404 });
  }
  return Response.json(response, {
    headers: { "Cache-Control": "no-store" },
  });
}
