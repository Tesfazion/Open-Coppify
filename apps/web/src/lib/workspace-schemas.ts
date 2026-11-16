import { z } from "zod";

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(80),
});

export const workspaceSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(["OWNER", "ADMIN", "EDITOR", "VIEWER"]),
});

export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceSummarySchema),
});

export const workspaceCreateResponseSchema = z.object({
  workspace: workspaceSummarySchema,
});

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
