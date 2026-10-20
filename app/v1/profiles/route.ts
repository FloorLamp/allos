import {
  authenticateDevice,
  deviceWritableProfileIds,
  refuse,
} from "@/lib/device-logins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The profiles the device's login reaches, so a device can name one with
// `?profile=<id>` on the other routes. Names only: no health data.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  const writable = new Set(deviceWritableProfileIds(auth));
  return Response.json(
    {
      profile: auth.profile.id,
      profiles: auth.profiles.map((p) => ({
        id: p.id,
        name: p.name,
        access: writable.has(p.id) ? "write" : "read",
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
