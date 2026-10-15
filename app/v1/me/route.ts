import { authenticateDevice, refuse } from "@/lib/device-logins";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Who the device acts as: its linked login and the profiles it reaches. `owner` is
// allos's own definition of the owner account — the `admin` role (lib/auth.ts), which
// is what bypasses grants everywhere else — never a name match. Labels only: no
// health data.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  return Response.json(
    {
      login: { id: auth.login.id, label: auth.login.username },
      owner: auth.login.role === "admin",
      profiles: auth.profiles.map((p) => ({ id: p.id, label: p.name })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
