import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import {
  emailEnabled,
  googleEnabled,
  oidcEnabled,
} from "@/lib/auth-providers";

export const instant = false;

export default async function SignInPage() {
  const session = await auth();
  if (session?.user) {
    redirect("/dashboard");
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-xl items-center px-6 py-12">
      <section className="w-full rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Coppify
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-950">
          Create your creator account
        </h1>
        <p className="mt-3 text-zinc-600">
          Sign in or create an account to turn long videos into short-form clips.
        </p>
        {googleEnabled && (
          <form
            className="mt-8"
            action={async () => {
              "use server";
              await signIn("google", { redirectTo: "/dashboard" });
            }}
          >
            <button
              className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-semibold text-zinc-950 transition hover:bg-zinc-50"
              type="submit"
            >
              Continue with Google
            </button>
          </form>
        )}
        {emailEnabled && (
          <form
            className={`${googleEnabled ? "mt-6" : "mt-8"} space-y-3`}
            action={async (formData: FormData) => {
              "use server";
              const email = formData.get("email");
              if (typeof email !== "string" || !email.trim()) {
                throw new Error("Enter a valid email address.");
              }
              await signIn("resend", {
                email: email.trim(),
                redirectTo: "/dashboard",
              });
            }}
          >
            <label
              className="block text-sm font-medium text-zinc-700"
              htmlFor="email"
            >
              Email address
            </label>
            <input
              autoComplete="email"
              className="w-full rounded-xl border border-zinc-300 px-4 py-3 text-sm text-zinc-950 outline-none transition placeholder:text-zinc-400 focus:border-zinc-500 focus:ring-2 focus:ring-zinc-200"
              id="email"
              name="email"
              placeholder="you@example.com"
              required
              type="email"
            />
            <button
              className="w-full rounded-xl bg-zinc-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-zinc-700"
              type="submit"
            >
              Email me a sign-in link
            </button>
          </form>
        )}
        {oidcEnabled && (
          <form
            className={`${googleEnabled || emailEnabled ? "mt-6" : "mt-8"}`}
            action={async () => {
              "use server";
              await signIn("coppify-oidc", { redirectTo: "/dashboard" });
            }}
          >
            <button
              className="w-full rounded-xl border border-zinc-300 bg-white px-4 py-3 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-50"
              type="submit"
            >
              Continue with organization SSO
            </button>
          </form>
        )}
        {!googleEnabled && !emailEnabled && !oidcEnabled && (
          <div
            className="mt-8 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
            role="status"
          >
            Sign-in is not configured. Set up Google or email sign-in using the
            instructions in <code>apps/web/README.md</code>.
          </div>
        )}
      </section>
    </main>
  );
}
