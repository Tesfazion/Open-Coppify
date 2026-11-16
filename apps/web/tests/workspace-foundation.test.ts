import assert from "node:assert/strict";
import test from "node:test";
import { createAuthProviders } from "../src/lib/auth-providers";
import { createOidcProvider } from "../src/lib/oidc";
import {
  createWorkspaceSchema,
  workspaceCreateResponseSchema,
} from "../src/lib/workspace-schemas";

test("workspace names are trimmed and constrained to 2 to 80 characters", () => {
  const valid = createWorkspaceSchema.safeParse({ name: "  Creator team  " });

  assert.equal(valid.success, true);
  if (valid.success) {
    assert.equal(valid.data.name, "Creator team");
  }

  assert.equal(createWorkspaceSchema.safeParse({ name: " " }).success, false);
  assert.equal(
    createWorkspaceSchema.safeParse({ name: "x".repeat(81) }).success,
    false,
  );
});

test("workspace API responses reject invalid membership roles", () => {
  const response = workspaceCreateResponseSchema.safeParse({
    workspace: {
      id: "workspace-id",
      name: "Creator team",
      slug: "creator-team-12345678",
      role: "ROOT",
    },
  });

  assert.equal(response.success, false);
});

test("OIDC can be omitted locally but partial configuration fails explicitly", () => {
  assert.equal(createOidcProvider({}), null);
  assert.throws(
    () =>
      createOidcProvider({
        AUTH_OIDC_ISSUER: "https://identity.example",
      }),
    /Set AUTH_OIDC_ISSUER/,
  );
});

test("OIDC requires HTTPS in production and accepts complete configuration", () => {
  assert.throws(
    () =>
      createOidcProvider({
        NODE_ENV: "production",
        AUTH_OIDC_ISSUER: "http://identity.example",
        AUTH_OIDC_CLIENT_ID: "client",
        AUTH_OIDC_CLIENT_SECRET: "secret",
      }),
    /must use HTTPS/,
  );

  const provider = createOidcProvider({
    AUTH_OIDC_ISSUER: "https://identity.example",
    AUTH_OIDC_CLIENT_ID: "client",
    AUTH_OIDC_CLIENT_SECRET: "secret",
  });
  assert.equal(provider?.id, "coppify-oidc");
});

test("Google and email sign-in can be configured independently", () => {
  const googleProviders = createAuthProviders({
    AUTH_GOOGLE_ID: "google-client",
    AUTH_GOOGLE_SECRET: "google-secret",
  });
  assert.deepEqual(
    googleProviders.map((provider) => provider.id),
    ["google"],
  );

  const emailProviders = createAuthProviders({
    AUTH_RESEND_KEY: "resend-test-key",
    AUTH_EMAIL_FROM: "login@example.com",
  });
  assert.deepEqual(
    emailProviders.map((provider) => provider.id),
    ["resend"],
  );
});

test("auth provider configuration rejects incomplete or invalid settings", () => {
  assert.deepEqual(createAuthProviders({}), []);
  assert.throws(
    () => createAuthProviders({ AUTH_GOOGLE_ID: "google-client" }),
    /Set AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET together/,
  );
  assert.throws(
    () => createAuthProviders({ AUTH_RESEND_KEY: "resend-test-key" }),
    /Set AUTH_RESEND_KEY and AUTH_EMAIL_FROM together/,
  );
});
