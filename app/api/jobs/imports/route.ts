import { getCurrentSession } from "@/lib/auth";
import { db } from "@/lib/db";
import type { ImportJobState } from "@/lib/toaster-poll";

// Import-job liveness for components/ImportJobsToaster (issue #1878).
//
// WHY A ROUTE HANDLER AND NOT THE SERVER ACTION IT REPLACED. A Server Action's
// response carries a freshly rendered page tree that Next's router applies —
// which repainted the page under a half-typed record form with no
// `router.refresh()` involved, outside everything the dirty-form registry gates.
// A `fetch` of this endpoint cannot carry an RSC tree, so observation stays at
// full cadence (the toast fires the moment the job finishes) while the repaint
// is left to `useChromeRefresh()`, which defers. lib/toaster-poll.ts holds the
// full reasoning and the response parser.
//
// AUTH — a route handler, so it authenticates the way the other in-app endpoints
// do: cookie-authoritative getCurrentSession(), never the coarse middleware
// cookie-presence check. A missing session is a 401, which the poller treats as a
// transient refusal and retries; it must never be read as "no jobs" (that would
// wipe its seed and re-announce every finished job).
//
// SCOPE — the session's ACTIVE profile only, which is what makes the toaster's
// per-profile seed reset (#296) meaningful.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const session = await getCurrentSession();
  if (!session) {
    return Response.json({ ok: false, error: "auth" }, { status: 401 });
  }
  const states = db
    .prepare(
      "SELECT id, status, summary, error FROM import_jobs WHERE profile_id = ? ORDER BY id"
    )
    .all(session.profile.id) as ImportJobState[];
  return Response.json(
    { ok: true, states },
    { headers: { "Cache-Control": "no-store" } }
  );
}
