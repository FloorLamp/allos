import { authenticateDevice, refuse } from "@/lib/device-logins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// What only the owner can fix to keep allos's data flowing (spaceport
// shared/BACKEND.md *Needs*). allos has no source whose sign-in or pairing lapses
// behind a device yet, so the list is empty; the route exists because every Deck
// backend answers it.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  return Response.json(
    { needs: [] },
    { headers: { "Cache-Control": "no-store" } }
  );
}
