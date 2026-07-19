import { redirect } from "next/navigation";
import Wordmark from "@/components/Wordmark";
import { getCurrentSession } from "@/lib/auth";
import { safeNextPath } from "@/lib/login-security";
import { isDemoMode, DEMO_USERNAME, DEMO_PASSWORD } from "@/lib/demo";
import { canSendAuthEmail } from "@/lib/auth-email";
import LoginForm from "./LoginForm";

// Reading cookies() makes this dynamic — required, since the redirect-if-already
// -authed check must run per request.
export const dynamic = "force-dynamic";

export default async function LoginPage(props: {
  searchParams: Promise<{ next?: string }>;
}) {
  const searchParams = await props.searchParams;
  const next = safeNextPath(searchParams.next);
  // Already signed in — skip the form and go where they were headed.
  if (await getCurrentSession()) redirect(next);

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
          {canSendAuthEmail() && (
            <a
              href="/forgot-password"
              data-testid="forgot-password-link"
              className="mt-4 block text-center text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              Forgot password?
            </a>
          )}
        </div>
        {isDemoMode() && (
          <div
            data-testid="demo-credentials"
            className="mt-4 rounded-2xl border border-amber-400/40 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <p className="font-semibold">
              Explore the demo with synthetic data
            </p>
            <p className="mt-1 text-amber-800/90 dark:text-amber-200/80">
              Sign in as the read-only demo user to browse a fully populated,
              synthetic health record. You can look at everything; editing is
              disabled.
            </p>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              <dt className="text-amber-700 dark:text-amber-300/80">
                username
              </dt>
              <dd className="font-semibold" data-testid="demo-username">
                {DEMO_USERNAME}
              </dd>
              <dt className="text-amber-700 dark:text-amber-300/80">
                password
              </dt>
              <dd className="font-semibold" data-testid="demo-password">
                {DEMO_PASSWORD}
              </dd>
            </dl>
          </div>
        )}
      </div>
    </main>
  );
}
