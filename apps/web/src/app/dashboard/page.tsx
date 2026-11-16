import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { listUserWorkspaces } from "@/lib/workspaces";
import { WorkspaceDashboard } from "./workspace-dashboard";

export const instant = false;

export default async function DashboardPage() {
  const session = await auth();
  const userId = session?.user?.id;

  if (!userId) {
    redirect("/sign-in");
  }

  const workspaces = await listUserWorkspaces(userId);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-12">
      <header className="mb-10 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-zinc-500">Coppify workspace</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-zinc-950">
            Welcome{session.user.name ? `, ${session.user.name}` : ""}
          </h1>
          <p className="mt-2 max-w-2xl text-zinc-600">
            Your account and tenant-scoped workspace foundation are ready. Video
            projects and processing will be added in the next implementation stage.
          </p>
        </div>
        <form
          action={async () => {
            "use server";
            await signOut({ redirectTo: "/" });
          }}
        >
          <button
            className="rounded-xl border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100"
            type="submit"
          >
            Sign out
          </button>
        </form>
      </header>
      <WorkspaceDashboard initialWorkspaces={workspaces} />
    </main>
  );
}
