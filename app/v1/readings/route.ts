import {
  authenticateDevice,
  deviceJsonBody,
  deviceMayWrite,
  refuse,
} from "@/lib/device-logins";
import { today } from "@/lib/db";
import { getLatestBodyMetricDated, getVitalsLatestModel } from "@/lib/queries";
import { insertBodyMetric, insertVitals } from "@/lib/offline/writes";
import { isPastWriteAccepted } from "@/lib/log-manifest";
import { revalidateRoute } from "@/lib/revalidate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The latest readings: the body metrics (canonical kg, %, bpm) and the Latest-vitals
// card's blood pressure, each dated by its own profile-local day.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:read");
  if (!auth.ok) return refuse(auth);
  const pid = auth.profile.id;
  const day = today(pid);
  const readings: Record<string, unknown>[] = [];
  const body = (kind: "weight" | "body_fat" | "resting_hr", unit: string) => {
    const latest = getLatestBodyMetricDated(pid, kind);
    if (latest)
      readings.push({ kind, value: latest.value, unit, date: latest.date });
  };
  body("weight", "kg");
  body("body_fat", "%");
  body("resting_hr", "bpm");
  const bp = getVitalsLatestModel(pid, day)?.bp;
  if (bp)
    readings.push({
      kind: "blood_pressure",
      systolic: bp.systolic,
      diastolic: bp.diastolic,
      unit: "mmHg",
      date: bp.date,
      freshness: bp.freshness,
    });
  return Response.json(
    { profile: pid, day, readings },
    { headers: { "Cache-Control": "no-store" } }
  );
}

const str = (v: unknown): string | null =>
  typeof v === "number" && Number.isFinite(v)
    ? String(v)
    : typeof v === "string" && v.trim()
      ? v.trim()
      : null;

// Log a reading, through the two cores the Trends measurements form posts to: a
// weigh-in (one manual row per day; a second post for the same day CORRECTS it) and
// the vitals (a fresh observation each). `day` is the profile-local day (default
// today; never the future), `at` an ISO instant the sitting states, judged by the
// cores against the profile's zone like every other stated time.
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:log");
  if (!auth.ok) return refuse(auth);
  if (!deviceMayWrite(auth))
    return Response.json({ error: "access" }, { status: 403 });
  const pid = auth.profile.id;
  const b = await deviceJsonBody(req);
  if (!b) return Response.json({ error: "body" }, { status: 400 });
  const day = str(b.day) ?? today(pid);
  if (!isPastWriteAccepted(today(pid), day))
    return Response.json({ error: "day" }, { status: 400 });
  const at = str(b.at);
  const occurredAt = at === null ? undefined : at;

  const weight = str(b.weight);
  const bodyFatPct = str(b.bodyFat);
  const restingHr = str(b.restingHr);
  const vitals = {
    systolic: str(b.systolic),
    diastolic: str(b.diastolic),
    glucose: str(b.glucose),
    glucoseUnit: str(b.glucoseUnit),
    spo2: str(b.spo2),
    temperature: str(b.temperature),
    tempUnit: str(b.tempUnit),
  };
  const anyVital = Object.values(vitals).some((v) => v !== null);
  if (!weight && !bodyFatPct && !restingHr && !anyVital)
    return Response.json({ error: "reading" }, { status: 400 });

  const wrote: string[] = [];
  let statedTimeRefused: string | undefined;
  if (weight || bodyFatPct || restingHr) {
    const out = insertBodyMetric(pid, {
      date: day,
      weight,
      weightUnit: b.weightUnit === "lb" ? "lb" : "kg",
      bodyFatPct,
      restingHr,
      notes: null,
      occurredAt,
      loggedVia: "quick-log",
    });
    if (out.wrote) {
      wrote.push("body");
      statedTimeRefused ??= out.statedTimeRefused;
    }
  }
  if (anyVital) {
    const out = insertVitals(pid, day, vitals, "quick-log", occurredAt);
    if (out.wrote) {
      wrote.push("vitals");
      statedTimeRefused ??= out.statedTimeRefused;
    }
  }
  if (wrote.length === 0)
    return Response.json({ error: "reading" }, { status: 400 });
  revalidateRoute(["/trends", "/"]);
  return Response.json(
    {
      profile: pid,
      day,
      wrote,
      ...(statedTimeRefused ? { statedTimeRefused } : {}),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
