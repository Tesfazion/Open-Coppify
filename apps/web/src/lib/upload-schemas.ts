import { z } from "zod";

export const supportedVideoTypes = [
  "video/mp4",
  "video/quicktime",
  "video/x-matroska",
  "video/webm",
] as const;

export const uploadInitSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    mimeType: z.enum(supportedVideoTypes),
    sizeBytes: z.number().int().positive().max(5_000_000_000),
  })
  .strict();

export const uploadInitResponseSchema = z.object({
  assetId: z.string().min(1),
  uploadUrl: z.url(),
  fields: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime(),
});

export const assetSummarySchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  originalFilename: z.string(),
  mimeType: z.enum(supportedVideoTypes),
  sizeBytes: z.string().regex(/^\d+$/),
  status: z.enum(["UPLOADING", "READY", "FAILED"]),
  createdAt: z.iso.datetime(),
});

export const assetCompleteResponseSchema = z.object({
  asset: assetSummarySchema,
});
