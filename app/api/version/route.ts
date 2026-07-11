import { getAppVersion } from "@/lib/version";
import { getCurrentSession } from "@/lib/auth";

// Reports the commit the running server was built from, so open tabs can detect
// a deploy (the process restarts with a new COMMIT_SHA) and prompt a refresh.
// force-dynamic + no-store so a CDN/browser never serves a stale hash.
export const dynamic = "force-dynamic";

// Cookie-authoritative session gate (mirrors the export/raw/logs handlers): the
// deployed commit sha + latest commit message are useful for targeting a
// known-vulnerable build, and this app is open source so the middleware's
// cookie-PRESENCE check is satisfied by any garbage cookie. The only legitimate
// callers are already-authenticated open tabs polling for a deploy, so require a
// real session and 401 anonymous callers (issue #390).
export async function GET() {
  const session = await getCurrentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { sha, commitMessage } = getAppVersion();
  return Response.json(
    { sha, commitMessage },
    { headers: { "Cache-Control": "no-store" } }
  );
}
