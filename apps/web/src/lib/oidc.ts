import { z } from "zod";
import type { OIDCConfig } from "next-auth/providers";

type OidcProfile = {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
};

type OidcEnvironmentVariables = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "AUTH_OIDC_ISSUER"
    | "AUTH_OIDC_CLIENT_ID"
    | "AUTH_OIDC_CLIENT_SECRET"
    | "AUTH_OIDC_NAME"
    | "NODE_ENV"
  >
>;

const optionalEnvironmentValue = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().optional(),
);

const oidcEnvironmentSchema = z.object({
  issuer: optionalEnvironmentValue.pipe(z.string().url().optional()),
  clientId: optionalEnvironmentValue.pipe(z.string().min(1).optional()),
  clientSecret: optionalEnvironmentValue.pipe(z.string().min(1).optional()),
  name: optionalEnvironmentValue.pipe(z.string().trim().min(1).max(80).optional()),
});

export function createOidcProvider(
  variables: OidcEnvironmentVariables = process.env,
): OIDCConfig<OidcProfile> | null {
  const environment = oidcEnvironmentSchema.parse({
    issuer: variables.AUTH_OIDC_ISSUER,
    clientId: variables.AUTH_OIDC_CLIENT_ID,
    clientSecret: variables.AUTH_OIDC_CLIENT_SECRET,
    name: variables.AUTH_OIDC_NAME,
  });

  const { issuer, clientId, clientSecret } = environment;
  if (!issuer && !clientId && !clientSecret) {
    return null;
  }
  if (!issuer || !clientId || !clientSecret) {
    throw new Error(
      "Set AUTH_OIDC_ISSUER, AUTH_OIDC_CLIENT_ID, and AUTH_OIDC_CLIENT_SECRET together.",
    );
  }

  if (
    variables.NODE_ENV === "production" &&
    new URL(issuer).protocol !== "https:"
  ) {
    throw new Error("AUTH_OIDC_ISSUER must use HTTPS in production.");
  }

  return {
    id: "coppify-oidc",
    name: environment.name ?? "OpenID Connect",
    type: "oidc",
    issuer,
    clientId,
    clientSecret,
    authorization: {
      params: {
        scope: "openid profile email",
      },
    },
    profile(profile) {
      return {
        id: profile.sub,
        name: profile.name ?? null,
        email: profile.email ?? null,
        image: profile.picture ?? null,
      };
    },
  };
}

export const oidcProvider = createOidcProvider();
export const oidcEnabled = oidcProvider !== null;
