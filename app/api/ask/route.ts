import {
  authenticateDevice,
  deviceJsonBody,
  refuse,
} from "@/lib/device-logins";
import { askRecords } from "@/lib/device-ask";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The session twin of /v1/ask (docs/device-api.md, *Web twins*), as a same-origin
// JSON POST `{q, profile?}` so the write guard applies (FloorLamp/allos#6088): on a
// GET, a cross-site `<img>`, no-cors fetch or navigation would carry the cookie and
// spend a model call on an attacker's question. No GET: 405. `profile` is the body's
// `?profile=`: one the login reaches, else 403 `profile` before any model call.
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:ask");
  if (!auth.ok) return refuse(auth);
  const body = await deviceJsonBody(req);
  const asked = body?.profile;
  const profile =
    asked == null
      ? auth.profile
      : auth.profiles.find((p) => p.id === Number(asked));
  if (!profile) return Response.json({ error: "profile" }, { status: 403 });
  const q = body?.q;
  return askRecords({ ...auth, profile }, typeof q === "string" ? q : "");
}
