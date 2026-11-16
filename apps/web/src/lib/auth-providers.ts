import Google from "next-auth/providers/google";
import Resend from "next-auth/providers/resend";
import { z } from "zod";
import { createOidcProvider } from "@/lib/oidc";

type AuthEnvironmentVariables = Partial<
  Pick<
    NodeJS.ProcessEnv,
    | "AUTH_GOOGLE_ID"
    | "AUTH_GOOGLE_SECRET"
    | "AUTH_RESEND_KEY"
    | "AUTH_EMAIL_FROM"
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

const authEnvironmentSchema = z.object({
  googleId: optionalEnvironmentValue.pipe(z.string().min(1).optional()),
  googleSecret: optionalEnvironmentValue.pipe(z.string().min(1).optional()),
  resendKey: optionalEnvironmentValue.pipe(z.string().min(1).optional()),
  emailFrom: optionalEnvironmentValue.pipe(
    z.string().email("AUTH_EMAIL_FROM must be a valid email address.").optional(),
  ),
});

export function createAuthProviders(
  variables: AuthEnvironmentVariables = process.env,
) {
  const environment = authEnvironmentSchema.parse({
    googleId: variables.AUTH_GOOGLE_ID,
    googleSecret: variables.AUTH_GOOGLE_SECRET,
    resendKey: variables.AUTH_RESEND_KEY,
    emailFrom: variables.AUTH_EMAIL_FROM,
  });

  const { googleId, googleSecret, resendKey, emailFrom } = environment;

  if ((!googleId && googleSecret) || (googleId && !googleSecret)) {
    throw new Error("Set AUTH_GOOGLE_ID and AUTH_GOOGLE_SECRET together.");
  }
  if ((!resendKey && emailFrom) || (resendKey && !emailFrom)) {
    throw new Error("Set AUTH_RESEND_KEY and AUTH_EMAIL_FROM together.");
  }

  const providers = [
    ...(googleId && googleSecret
      ? [Google({ clientId: googleId, clientSecret: googleSecret })]
      : []),
    ...(resendKey && emailFrom
      ? [Resend({ apiKey: resendKey, from: emailFrom })]
      : []),
  ];

  const oidcProvider = createOidcProvider(variables);
  if (oidcProvider) {
    providers.push(oidcProvider);
  }

  return providers;
}

export const authProviders = createAuthProviders();
export const googleEnabled = authProviders.some(
  (provider) => provider.id === "google",
);
export const emailEnabled = authProviders.some(
  (provider) => provider.id === "resend",
);
export const oidcEnabled = authProviders.some(
  (provider) => provider.id === "coppify-oidc",
);
