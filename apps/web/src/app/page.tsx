import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-6xl items-center px-6 py-16">
      <div className="max-w-3xl">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">
          Coppify
        </p>
        <h1 className="mt-5 text-5xl font-semibold tracking-tight text-zinc-950 sm:text-7xl">
          One conversation.
          <br />
          Many stories worth sharing.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-zinc-600">
          Turn long-form video into polished, review-ready short clips with
          transcript intelligence, speaker-aware framing, and captions.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link
            className="rounded-xl bg-zinc-950 px-5 py-3 text-sm font-semibold text-white hover:bg-zinc-700"
            href="/sign-in"
          >
            Sign in
          </Link>
          <Link
            className="rounded-xl border border-zinc-300 px-5 py-3 text-sm font-semibold text-zinc-800 hover:bg-zinc-100"
            href="/dashboard"
          >
            Open dashboard
          </Link>
        </div>
      </div>
    </main>
  );
}
