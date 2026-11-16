import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRedisUrl,
  processingQueuePayloadSchema,
  QueueConfigurationError,
} from "../src/lib/processing-queue";
import { idempotencyKeySchema } from "../src/lib/processing-job-schemas";

test("Redis URLs require a supported protocol and TLS in production", () => {
  assert.equal(
    parseRedisUrl({ REDIS_URL: "redis://localhost:6379" }),
    "redis://localhost:6379",
  );
  assert.equal(
    parseRedisUrl({
      NODE_ENV: "production",
      REDIS_URL: "rediss://cache.example:6380",
    }),
    "rediss://cache.example:6380",
  );
  assert.throws(
    () =>
      parseRedisUrl({
        NODE_ENV: "production",
        REDIS_URL: "redis://cache.example:6379",
      }),
    QueueConfigurationError,
  );
  assert.throws(
    () => parseRedisUrl({ REDIS_URL: "http://cache.example" }),
    /redis or rediss protocol/,
  );
  assert.throws(
    () => parseRedisUrl({ REDIS_URL: "redis:///" }),
    /must include a host/,
  );
});

test("queue payloads and idempotency keys reject malformed inputs", () => {
  const payload = {
    processingJobId: "job-id",
    workspaceId: "workspace-id",
    projectId: "project-id",
    sourceAssetId: "asset-id",
  };
  assert.equal(processingQueuePayloadSchema.safeParse(payload).success, true);
  assert.equal(
    processingQueuePayloadSchema.safeParse({ ...payload, extra: "untrusted" })
      .success,
    false,
  );
  assert.equal(idempotencyKeySchema.safeParse("request-123").success, true);
  assert.equal(idempotencyKeySchema.safeParse("short").success, false);
  assert.equal(idempotencyKeySchema.safeParse("bad key").success, false);
});
