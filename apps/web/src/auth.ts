import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import { createPersonalWorkspace } from "@/lib/workspaces";
import { prisma } from "@/lib/db";
import { authProviders } from "@/lib/auth-providers";

if (
  process.env.NODE_ENV === "production" &&
  (!process.env.AUTH_SECRET ||
    Buffer.byteLength(process.env.AUTH_SECRET, "utf8") < 32)
) {
  throw new Error("AUTH_SECRET must contain at least 32 bytes in production.");
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: authProviders,
  session: {
    strategy: "database",
  },
  pages: {
    signIn: "/sign-in",
    verifyRequest: "/verify-request",
  },
  callbacks: {
    session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      if (!user.id) {
        throw new Error("The identity provider returned a user without a stable id.");
      }

      const baseName =
        user.name?.trim() || user.email?.split("@")[0]?.trim() || "Creator";
      await createPersonalWorkspace(user.id, `${baseName}'s workspace`);
    },
  },
});
