import { getCurrentSession, getAccessibleProfiles } from "@/lib/auth";
import { createLogger } from "@/lib/log";
import { localStampMinute } from "@/lib/intraday";
import { clampFineWindow } from "@/lib/intraday-layout";
import { getHrMinutesInRange } from "@/lib/queries/metrics";

// Per-minute heart rate for a ZOOMED window on the Timeline day chart (issue
// #1515 D). The chart's base series is 5-minute buckets, which is all a 24-hour
// plot can resolve; when the reader zooms into a 45-minute activity the same 680
// units become ~15 per minute, and per-minute detail is what makes intervals,
// drift and recovery legible. So the finer series is fetched for the SELECTED
// window only, and refines the drawn line in place.
//
// AUTH — a ROUTE HANDLER, so it authenticates the way the export routes do:
// cookie-authoritative getCurrentSession(), never the coarse middleware cookie
// check. A missing session is 401.
//
// PROFILE — the Timeline day view can render a VIEWED profile's day (a
// cross-profile scope's daySubjectId), not only the acting one, so the window is
// requested for a named profile. That id is never trusted: it is intersected with
// this login's accessible set before a single row is read, exactly as the offline
// replay route does, and an absent one falls back to the session's active profile.
// A second profile's minutes are unreachable from here.
//
// ERRORS follow the #478 route shape — `{ ok: false, error }` — and a 500's
// message stays generic, with the detailed cause going to the logger.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("api/intraday/hr");

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const session = await getCurrentSession();
  if (!session) {
    return Response.json({ ok: false, error: "auth" }, { status: 401 });
  }

  const url = new URL(req.url);
  const date = url.searchParams.get("date") ?? "";
  if (!ISO_DATE.test(date)) {
    return Response.json({ ok: false, error: "date" }, { status: 400 });
  }

  const window = clampFineWindow(
    Number(url.searchParams.get("from")),
    Number(url.searchParams.get("to"))
  );
  if (!window) {
    return Response.json({ ok: false, error: "window" }, { status: 400 });
  }

  const requested = url.searchParams.get("profile");
  let profileId = session.profile.id;
  if (requested != null) {
    const id = Number(requested);
    const accessible = await getAccessibleProfiles();
    if (!Number.isInteger(id) || !accessible.some((p) => p.id === id)) {
      // Not "not found" and not a redirect to the active profile: an id this
      // login cannot reach is a forbidden request, answered as one.
      return Response.json({ ok: false, error: "profile" }, { status: 403 });
    }
    profileId = id;
  }

  try {
    // hr_minutes.ts is a PROFILE-LOCAL 'YYYY-MM-DDTHH:MM' by design (#94), so the
    // day's own rows are the whole search space for a window inside that day —
    // no timezone conversion happens here or in the chart.
    const points = getHrMinutesInRange(profileId, date, date)
      .flatMap((row) => {
        const minute = localStampMinute(date, row.ts);
        return minute == null ||
          minute < window.from ||
          minute > window.to ||
          !Number.isFinite(row.bpm)
          ? []
          : [{ minute, bpm: Math.round(row.bpm * 10) / 10 }];
      })
      .sort((a, b) => a.minute - b.minute);
    return Response.json({ ok: true, date, ...window, points });
  } catch (err) {
    log.error("per-minute heart-rate window failed", { err });
    return Response.json({ ok: false, error: "server" }, { status: 500 });
  }
}
