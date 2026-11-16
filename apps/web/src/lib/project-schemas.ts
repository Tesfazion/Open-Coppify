import { z } from "zod";

export const createProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
  })
  .strict();

export const projectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(2).max(120),
  createdAt: z.iso.datetime(),
});

export const projectListResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
});

export const projectCreateResponseSchema = z.object({
  project: projectSummarySchema,
});
