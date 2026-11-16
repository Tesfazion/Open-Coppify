export default function VerifyRequestPage() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-xl items-center px-6 py-12">
      <section className="w-full rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Coppify
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-zinc-950">
          Check your email
        </h1>
        <p className="mt-3 text-zinc-600">
          If the address can sign in, we sent a secure link. Open it to continue
          to your workspace.
        </p>
        <a
          className="mt-8 inline-flex text-sm font-semibold text-zinc-800 underline underline-offset-4"
          href="/sign-in"
        >
          Return to sign in
        </a>
      </section>
    </main>
  );
}
