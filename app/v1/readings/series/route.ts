import { authenticateDevice, refuse } from "@/lib/device-logins";
import {
  READING_KINDS,
  readingSeries,
  type ReadingKind,
} from "@/lib/device-health-records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DAYS = 3650;

// One reading's series (lib/device-health-records.ts): `kind` one of /v1/readings'
// kinds, `days` its most recent days with data (1–3650, default 365).
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  const params = new URL(req.url).searchParams;
  const kind = params.get("kind") ?? "";
  if (!(READING_KINDS as readonly string[]).includes(kind))
    return Response.json({ error: "kind" }, { status: 400 });
  const days = Math.min(
    MAX_DAYS,
    Math.max(1, Number(params.get("days")) || 365)
  );
  return Response.json(
    {
      profile: auth.profile.id,
      ...readingSeries(auth.profile.id, kind as ReadingKind, days),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
