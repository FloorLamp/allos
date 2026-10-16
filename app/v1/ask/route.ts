import { authenticateDevice, refuse } from "@/lib/device-logins";
import { askRecords } from "@/lib/device-ask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A device's record question, `?q=` (lib/device-ask.ts). The session twin is a POST
// (app/api/ask/route.ts): a cookie-authenticated GET would let a cross-site image or
// navigation spend model calls.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:ask");
  if (!auth.ok) return refuse(auth);
  return askRecords(auth, new URL(req.url).searchParams.get("q") ?? "");
}
