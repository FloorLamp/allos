import { getCurrentSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { readDataWriteRevision } from "@/lib/write-revision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cookie-authoritative, active-profile-only observation for the authenticated app
// shell. The client supplies no subject identifier and receives no health data.
export async function GET(): Promise<Response> {
  const session = await getCurrentSession();
  if (!session) {
    return Response.json({ ok: false, error: "auth" }, { status: 401 });
  }
  return Response.json(
    {
      profileId: session.profile.id,
      revision: String(readDataWriteRevision(db)),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
