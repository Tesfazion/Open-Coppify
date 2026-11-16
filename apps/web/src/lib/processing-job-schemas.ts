import { z } from "zod";

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

export const processingJobSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  sourceAssetId: z.string().min(1),
  status: z.enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"]),
  stage: z.string().nullable(),
  progress: z.number().int().min(0).max(100),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const processingJobResponseSchema = z.object({
  job: processingJobSummarySchema,
  events: z.array(
    z.object({
      id: z.string().min(1),
      eventType: z.string(),
      status: z
        .enum(["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED"])
        .nullable(),
      stage: z.string().nullable(),
      progress: z.number().int().min(0).max(100).nullable(),
      message: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
});
