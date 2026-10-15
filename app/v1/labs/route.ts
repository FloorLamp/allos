import { authenticateDevice, refuse } from "@/lib/device-logins";
import { today } from "@/lib/db";
import { getClinicalObservations } from "@/lib/queries";
import { recentLabHighlights } from "@/lib/recent-labs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 50;

// Recent labs: the dashboard's highlight selection (lib/recent-labs.ts) over the
// profile's current (latest-per-marker) readings, notable flags first then newest.
// Freshness is judged against the PROFILE-local day.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 10)
  );
  const day = today(auth.profile.id);
  const labs = recentLabHighlights(
    getClinicalObservations(auth.profile.id, { current: true }),
    limit,
    day
  );
  return Response.json(
    { profile: auth.profile.id, day, labs },
    { headers: { "Cache-Control": "no-store" } }
  );
}
