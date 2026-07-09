import { redirect } from "next/navigation";
import Wordmark from "@/components/Wordmark";
import { getCurrentSession } from "@/lib/auth";
import { safeNextPath } from "@/lib/login-security";
import LoginForm from "./LoginForm";

// Reading cookies() makes this dynamic — required, since the redirect-if-already
// -authed check must run per request.
export const dynamic = "force-dynamic";

export default function LoginPage({
  searchParams,
}: {
  searchParams: { next?: string };
}) {
  const next = safeNextPath(searchParams.next);
  // Already signed in — skip the form and go where they were headed.
  if (getCurrentSession()) redirect(next);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <Wordmark markClassName="h-8 w-14" />
        </div>
        <div className="rounded-2xl border border-black/10 bg-white/70 p-6 shadow-sm backdrop-blur-xl dark:border-white/5 dark:bg-ink-950/70">
          <h1 className="mb-1 text-lg font-semibold text-slate-800 dark:text-slate-100">
            Sign in
          </h1>
          <p className="mb-6 text-sm text-slate-500 dark:text-slate-400">
            Enter your credentials to continue.
          </p>
          <LoginForm next={next} />
        </div>
      </div>
    </main>
  );
}
