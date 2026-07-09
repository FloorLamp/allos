import { getAppVersion } from "@/lib/version";

// Reports the commit the running server was built from, so open tabs can detect
// a deploy (the process restarts with a new COMMIT_SHA) and prompt a refresh.
// force-dynamic + no-store so a CDN/browser never serves a stale hash.
export const dynamic = "force-dynamic";

export function GET() {
  const { sha, commitMessage } = getAppVersion();
  return Response.json(
    { sha, commitMessage },
    { headers: { "Cache-Control": "no-store" } }
  );
}
