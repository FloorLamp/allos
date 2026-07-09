import { getCurrentSession } from "@/lib/auth";
import { getSyncEventRawRef } from "@/lib/queries";
import { readRawPayload } from "@/lib/integrations/raw-log";

// Admin-only raw provider payload viewer for a sync event (issue #9). Serves the
// exact request/response body a sync exchanged with the provider, so "why did/
// didn't this change" is debuggable from the UI. Node runtime (reads fs).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  // Raw payloads are PHI-adjacent and mix content across every profile, so this is
  // admin-only — mirror the AI-log SSE gate exactly: cookie-authoritative check
  // (the Edge middleware only checks cookie presence); no session → 401; a member
  // gets 404 (not 403) so the endpoint's existence isn't confirmed.
  const session = getCurrentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (session.login.role !== "admin") {
    return new Response("Not found", { status: 404 });
  }

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return new Response("Not found", { status: 404 });
  }

  // Profile-scoped: resolve the ref only for an event owned by the active profile,
  // then read the payload from that profile's directory.
  const ref = getSyncEventRawRef(session.profile.id, id);
  if (!ref) {
    return new Response("Not found", { status: 404 });
  }
  const raw = readRawPayload(session.profile.id, ref);
  if (raw === null) {
    return new Response("Not found", { status: 404 });
  }

  // Pretty-print when it parses as JSON (the payloads are provider JSON); fall back
  // to the stored text (e.g. a truncated/invalid body from a parse-failure event).
  let body = raw;
  try {
    body = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // leave `body` as the raw stored text
  }

  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
