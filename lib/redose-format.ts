// Pure formatters for the PRN redose notice (#798) — no DB/network, unit-tested in
// lib/__tests__/redose-format.test.ts. Shared by the notify orchestrator (the
// Telegram/push body) and the on-page surfacing (the med card + dashboard widget), so
// every surface phrases the SAME redose state identically ("one question, one
// computation"). INFORMATIONAL only: the copy states elapsed time against the user's
// OWN confirmed numbers — never "you can take more".

import type { RedoseStatus } from "./prn-redose";

// A short "6h" / "6.5h" for an elapsed/remaining hour count, one decimal place at
// most (whole hours drop the decimal naturally). Pure.
export function hoursLabel(hours: number): string {
  const rounded = Math.round(Math.max(0, hours) * 10) / 10;
  return `${rounded}h`;
}

// The "N of M today" count fragment shared by the notice and the card.
export function countFragment(
  countToday: number,
  maxDailyCount: number
): string {
  return `${countToday} of ${maxDailyCount} today`;
}

// The one-shot redose NOTICE message (title + body) for the fire case. `lastClock` is
// the profile-local clock time of the arming administration ("4:02pm"); empty when
// unknown. Example: "6h since Ibuprofen (4:02pm) — your minimum interval has passed ·
// 2 of 4 today." `sinceName` (#1027) names the med the ARMING administration belongs
// to when a same-ingredient SIBLING's dose armed the clock — the body then reads
// honestly ("8h since Ibuprofen OTC") while the title keeps the notice's own item.
export function redoseNoticeMessage(input: {
  name: string;
  sinceHours: number;
  lastClock: string;
  countToday: number;
  maxDailyCount: number;
  sinceName?: string | null;
}): { title: string; body: string } {
  const at = input.lastClock ? ` (${input.lastClock})` : "";
  const since = input.sinceName?.trim() || input.name;
  return {
    title: `Redose window open — ${input.name}`,
    body:
      `${hoursLabel(input.sinceHours)} since ${since}${at} — your minimum ` +
      `interval has passed · ${countFragment(input.countToday, input.maxDailyCount)}.`,
  };
}

// The marker-agnostic status line for the med card / dashboard widget, or null when
// there's nothing useful to say (nothing logged today). Never permissive — it reports
// window state and the running count, deferring to the user's judgment:
//   • at the confirmed max → "Max reached · 4 of 4 today"
//   • window open          → "Redose OK — min interval passed · 2 of 4 today"
//   • not yet              → "Next dose in ~2h · 1 of 4 today"
// `familyMemberCount` (#1027) > 1 appends "across N items" so a counter fed by a
// same-ingredient sibling's doses says so ("the cross-item counter line").
export function redoseCardLabel(
  status: RedoseStatus | null,
  familyMemberCount = 1
): string | null {
  if (!status) return null;
  const count = countFragment(status.countToday, status.maxDailyCount);
  const across =
    familyMemberCount > 1 ? ` across ${familyMemberCount} items` : "";
  if (status.atMax) return `Max reached · ${count}${across}`;
  if (status.open) return `Redose OK — min interval passed · ${count}${across}`;
  return `Next dose in ~${hoursLabel(status.opensInHours)} · ${count}${across}`;
}
