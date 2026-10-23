import {
  authenticateDevice,
  deviceJsonBody,
  deviceMayWrite,
  refuse,
} from "@/lib/device-logins";
import { writeTx } from "@/lib/db";
import { isRealIsoDate, parseUtcSql, zonedDateParts } from "@/lib/date";
import { upsertPracticeLogs } from "@/lib/integrations/normalize";
import { normalizePracticeName, practiceIdentity } from "@/lib/practice";
import { getPracticeSpellingsMap } from "@/lib/queries/wellness";
import { getTimezone } from "@/lib/settings";
import { revalidateRoute } from "@/lib/revalidate";
import { devicePractices } from "@/lib/device-practices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  return Response.json(
    {
      profile: auth.profile.id,
      practices: await devicePractices(auth.profile.id),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:log");
  if (!auth.ok) return refuse(auth);
  if (!deviceMayWrite(auth))
    return Response.json({ error: "access" }, { status: 403 });
  const b = await deviceJsonBody(req);
  if (!b) return Response.json({ error: "body" }, { status: 400 });
  const practice =
    typeof b.practice === "string" ? normalizePracticeName(b.practice) : "";
  if (!practice) return Response.json({ error: "practice" }, { status: 400 });
  if (typeof b.key !== "string" || !b.key.trim())
    return Response.json({ error: "key" }, { status: 400 });
  if (
    typeof b.durationMin !== "number" ||
    !Number.isFinite(b.durationMin) ||
    b.durationMin <= 0
  )
    return Response.json({ error: "durationMin" }, { status: 400 });
  if (
    typeof b.end !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      b.end
    ) ||
    !isRealIsoDate(b.end.slice(0, 10))
  )
    return Response.json({ error: "end" }, { status: 400 });
  const end = parseUtcSql(b.end); // Validated ISO instant with an explicit zone.
  if (!end) return Response.json({ error: "end" }, { status: 400 });
  const start = new Date(end.getTime() - b.durationMin * 60_000);
  if (!Number.isFinite(start.getTime()))
    return Response.json({ error: "durationMin" }, { status: 400 });
  const { key, durationMin } = b;
  const pid = auth.profile.id;
  const { date: day, hhmm } = zonedDateParts(getTimezone(pid), start);
  const counts = writeTx(() =>
    upsertPracticeLogs(
      pid,
      [
        {
          external_id: key,
          practice:
            getPracticeSpellingsMap(pid).get(practiceIdentity(practice))?.[0] ??
            practice,
          date: day,
          start_time: hhmm,
          duration_min: durationMin,
        },
      ],
      `device:${auth.device}`
    )
  );
  const outcome = (
    ["inserted", "unchanged", "updated", "edited", "suppressed"] as const
  ).find((key) => counts[key] > 0)!;
  if (counts.inserted || counts.updated)
    revalidateRoute(["/wellness", "/history", "/longevity", "/upcoming", "/"]);
  return Response.json(
    { profile: pid, day, outcome },
    {
      headers: { "Cache-Control": "no-store" },
    }
  );
}
