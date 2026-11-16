"use client";

import { useState, type FormEvent } from "react";
import {
  workspaceCreateResponseSchema,
  type WorkspaceSummary,
} from "@/lib/workspace-schemas";

type Props = {
  initialWorkspaces: WorkspaceSummary[];
};

export function WorkspaceDashboard({ initialWorkspaces }: Props) {
  const [workspaces, setWorkspaces] = useState(initialWorkspaces);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof body === "object" &&
          body !== null &&
          "error" in body &&
          typeof body.error === "string"
            ? body.error
            : "Workspace could not be created.";
        setError(message);
        return;
      }

      const parsed = workspaceCreateResponseSchema.safeParse(body);
      if (!parsed.success) {
        setError("The server returned an invalid workspace response.");
        return;
      }

      setWorkspaces((current) => [...current, parsed.data.workspace]);
      setName("");
    } catch {
      setError("The request failed. Check your connection and try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-10">
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-500">
          Your workspaces
        </h2>
        {workspaces.length === 0 ? (
          <p className="mt-4 rounded-2xl border border-dashed border-zinc-300 p-6 text-sm text-zinc-600">
            No workspace is associated with this account yet. Create one to begin.
          </p>
        ) : (
          <ul className="mt-4 grid gap-3 sm:grid-cols-2">
            {workspaces.map((workspace) => (
              <li
                key={workspace.id}
                className="rounded-2xl border border-zinc-200 bg-white p-5"
              >
                <p className="font-semibold text-zinc-950">{workspace.name}</p>
                <p className="mt-1 text-sm text-zinc-500">
                  {workspace.role.toLowerCase()} · {workspace.slug}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="max-w-xl rounded-2xl border border-zinc-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-zinc-950">Create a workspace</h2>
        <p className="mt-1 text-sm text-zinc-600">
          Workspaces keep projects and media scoped to their members.
        </p>
        <form className="mt-5 space-y-3" onSubmit={createWorkspace}>
          <label className="block text-sm font-medium text-zinc-700" htmlFor="workspace-name">
            Workspace name
          </label>
          <input
            id="workspace-name"
            autoComplete="organization"
            maxLength={80}
            minLength={2}
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-xl border border-zinc-300 px-3 py-2.5 text-sm outline-none focus:border-zinc-950 focus:ring-2 focus:ring-zinc-950/10"
          />
          {error ? (
            <p className="text-sm text-red-700" role="alert">
              {error}
            </p>
          ) : null}
          <button
            disabled={isSubmitting}
            className="rounded-xl bg-zinc-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-60"
            type="submit"
          >
            {isSubmitting ? "Creating..." : "Create workspace"}
          </button>
        </form>
      </section>
    </div>
  );
}
