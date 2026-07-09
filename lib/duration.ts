// Hold durations for timed exercises (planks, dead hangs) are stored as whole
// seconds but entered/displayed as m:ss.

/** Format seconds as m:ss, e.g. 90 -> "1:30". Null/undefined -> "–". */
export function formatSeconds(sec: number | null | undefined): string {
  if (sec == null) return "–";
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Format minutes as "45 min" or "1h 05m" (for cardio/sport durations). Null -> "–". */
export function formatMinutes(min: number | null | undefined): string {
  if (min == null) return "–";
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Whether a string is a well-formed duration: plain whole seconds ("90") or
 * m:ss with the seconds part in 0–59 ("1:30"). Empty is not valid.
 */
export function isValidDuration(input: string): boolean {
  const t = input.trim();
  if (!t) return false;
  return t.includes(":") ? /^\d+:[0-5]?\d$/.test(t) : /^\d+$/.test(t);
}

/**
 * Parse a duration entered as "1:30", "0:45", or plain seconds ("90") into
 * whole seconds. Returns null for empty/unparseable input.
 */
export function parseSeconds(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  if (t.includes(":")) {
    const [mStr, sStr = "0"] = t.split(":");
    const m = Number(mStr);
    const s = Number(sStr);
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
    return Math.round(m * 60 + s);
  }
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}
