import { authenticateDevice, refuse } from "@/lib/device-logins";
import { markerDetail } from "@/lib/device-health-records";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One marker's page (lib/device-health-records.ts): `name` is a find row's
// clinical-result key after its colon, or a lab's name; unknown: 404 `marker`.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  const name = new URL(req.url).searchParams.get("name") ?? "";
  const marker = markerDetail(auth.profile.id, name);
  if (!marker) return Response.json({ error: "marker" }, { status: 404 });
  return Response.json(
    { profile: auth.profile.id, ...marker },
    { headers: { "Cache-Control": "no-store" } }
  );
}
