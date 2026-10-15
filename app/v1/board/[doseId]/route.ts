import {
  authenticateDevice,
  deviceJsonBody,
  deviceMayWrite,
  refuse,
} from "@/lib/device-logins";
import { today } from "@/lib/db";
import { doseLogDays } from "@/lib/dose-log-window";
import { setDoseStatusCore } from "@/lib/queries";
import { getTimezone } from "@/lib/settings";
import { statedInstantOnDate } from "@/lib/stated-time";
import { revalidateRoute } from "@/lib/revalidate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = { take: "taken", skip: "skipped", clear: "clear" } as const;
type Action = keyof typeof ACTIONS;

// Take, skip or clear one scheduled dose on the board, through the ONE resolution
// core the web tri-state check-off posts to (setDoseStatusCore): the dose must belong
// to the profile, the day must be today or the recent past, and a `take` may state
// its wall time; an `at` that does not parse is a 400, never a silent tap instant.
// A taken dose is never re-taken here: `take` with `at` on it is 409 already-taken
// (restating a taken dose's time stays the web's correction path, which keeps the
// row's id, recorded_at, logged_via and amount); `clear` undoes a take or a skip.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ doseId: string }> }
): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:log");
  if (!auth.ok) return refuse(auth);
  if (!deviceMayWrite(auth))
    return Response.json({ error: "access" }, { status: 403 });
  const { profile } = auth;

  const doseId = Number((await ctx.params).doseId);
  const body = await deviceJsonBody(req);
  const action = typeof body?.action === "string" ? body.action : "";
  const localToday = today(profile.id);
  const day = typeof body?.day === "string" && body.day ? body.day : localToday;
  if (!Number.isInteger(doseId) || doseId <= 0 || !(action in ACTIONS))
    return Response.json({ error: "action" }, { status: 400 });
  if (!doseLogDays(localToday).includes(day))
    return Response.json({ error: "day" }, { status: 400 });
  const target = ACTIONS[action as Action];
  const at = typeof body?.at === "string" ? body.at : "";
  // As setDoseStatus resolves it: a stated wall time on the day, else the tap
  // instant for today and no instant for a past day.
  const stated =
    target === "taken" && at
      ? statedInstantOnDate(day, at, getTimezone(profile.id))
      : null;
  if (target === "taken" && at && stated == null)
    return Response.json({ error: "at" }, { status: 400 });
  const takenAt =
    target === "taken"
      ? (stated ?? (day === localToday ? undefined : null))
      : undefined;

  const set = () =>
    setDoseStatusCore(profile.id, doseId, day, target, "quick-log", {
      takenAt,
    });
  const outcome = set();
  if (outcome === "unchanged" && target === "taken" && at)
    return Response.json({ error: "already-taken" }, { status: 409 });
  if (outcome === "stale-dose")
    return Response.json({ error: "dose" }, { status: 404 });
  if (outcome === "inactive")
    return Response.json({ error: "inactive" }, { status: 409 });
  revalidateRoute([
    "/nutrition",
    "/medications",
    "/supplies",
    "/upcoming",
    "/history",
    "/",
  ]);
  return Response.json(
    { profile: profile.id, day, dose: doseId, outcome },
    { headers: { "Cache-Control": "no-store" } }
  );
}
