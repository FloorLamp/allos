import { authenticateDevice, refuse } from "@/lib/device-logins";
import { searchAll } from "@/lib/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LIMIT = 50;

// Find across one profile's records: the command palette's search, flattened into
// rows (docs/device-api.md *Find*). Scoped to the resolved profile only, as the
// palette's Server Action is.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return Response.json({ error: "q" }, { status: 400 });
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(url.searchParams.get("limit")) || 20)
  );
  const results = searchAll(auth.profile.id, q, auth.login.id)
    .flatMap((group) =>
      group.hits.map((hit) => ({
        kind: hit.domain,
        ...(hit.loggedKind ? { loggedKind: hit.loggedKind } : {}),
        key: hit.key,
        title: hit.title,
        subtitle: hit.subtitle,
        date: hit.date,
        href: hit.href,
      }))
    )
    .slice(0, limit);
  return Response.json(
    { profile: auth.profile.id, results },
    { headers: { "Cache-Control": "no-store" } }
  );
}
