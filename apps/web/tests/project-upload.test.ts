import assert from "node:assert/strict";
import test from "node:test";
import { createProjectSchema } from "../src/lib/project-schemas";
import { hasSameOrigin } from "../src/lib/request-security";
import {
  parseStorageConfig,
  StorageConfigurationError,
} from "../src/lib/storage";
import { uploadInitSchema } from "../src/lib/upload-schemas";
import { canManageWorkspaceContent } from "../src/lib/workspace-permissions";
import { WorkspaceRole } from "../src/generated/prisma/client";

test("project names are trimmed and bounded", () => {
  const parsed = createProjectSchema.safeParse({ name: "  Interview series  " });

  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.name, "Interview series");
  }
  assert.equal(createProjectSchema.safeParse({ name: "x" }).success, false);
  assert.equal(
    createProjectSchema.safeParse({ name: "x".repeat(121) }).success,
    false,
  );
});

test("upload metadata accepts supported video formats and rejects unsafe sizes", () => {
  assert.equal(
    uploadInitSchema.safeParse({
      fileName: "session.mkv",
      mimeType: "video/x-matroska",
      sizeBytes: 512_000_000,
    }).success,
    true,
  );
  assert.equal(
    uploadInitSchema.safeParse({
      fileName: "session.exe",
      mimeType: "application/octet-stream",
      sizeBytes: 100,
    }).success,
    false,
  );
  assert.equal(
    uploadInitSchema.safeParse({
      fileName: "session.mp4",
      mimeType: "video/mp4",
      sizeBytes: 5_000_000_001,
    }).success,
    false,
  );
});

test("only workspace content roles can create projects and uploads", () => {
  assert.equal(canManageWorkspaceContent(null), false);
  assert.equal(canManageWorkspaceContent(WorkspaceRole.VIEWER), false);
  assert.equal(canManageWorkspaceContent(WorkspaceRole.EDITOR), true);
  assert.equal(canManageWorkspaceContent(WorkspaceRole.ADMIN), true);
});

test("mutating API requests require a matching origin", () => {
  const sameOrigin = new Request("https://app.example/api/projects", {
    method: "POST",
    headers: { origin: "https://app.example" },
  });
  const crossOrigin = new Request("https://app.example/api/projects", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  const noOrigin = new Request("https://app.example/api/projects", {
    method: "POST",
  });
  const forwardedOrigin = new Request("http://internal/api/projects", {
    method: "POST",
    headers: {
      origin: "https://app.example",
      "x-forwarded-host": "app.example",
      "x-forwarded-proto": "https",
    },
  });

  assert.equal(hasSameOrigin(sameOrigin), true);
  assert.equal(hasSameOrigin(crossOrigin), false);
  assert.equal(hasSameOrigin(noOrigin), false);
  assert.equal(hasSameOrigin(forwardedOrigin), true);
});

test("storage configuration rejects insecure production endpoints and partial credentials", () => {
  assert.throws(
    () =>
      parseStorageConfig({
        NODE_ENV: "production",
        S3_BUCKET: "media",
        S3_ENDPOINT: "http://objects.example",
      }),
    StorageConfigurationError,
  );
  assert.throws(
    () =>
      parseStorageConfig({
        S3_BUCKET: "media",
        S3_ACCESS_KEY_ID: "only-one",
      }),
    /Set both S3_ACCESS_KEY_ID/,
  );
  assert.equal(
    parseStorageConfig({
      S3_BUCKET: "media",
      S3_ENDPOINT: "http://localhost:9000",
    }).forcePathStyle,
    true,
  );
});
