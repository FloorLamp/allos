// Pure formatters for the PRN redose notice (#798) — no DB/network, unit-tested in
// lib/__tests__/redose-format.test.ts. Shared by the notify orchestrator (the
// Telegram/push body) and the on-page surfacing (the med card + dashboard widget), so
// every surface phrases the SAME redose state identically ("one question, one
// computation"). INFORMATIONAL only: the copy states elapsed time against the user's
// OWN confirmed numbers — never "you can take more".

import type { RedoseStatus } from "./prn-redose";
import { formatMedicationDoseProduct } from "./medication-dose-format";

// A short "6h" / "6.5h" for an elapsed/remaining hour count, one decimal place at
// most (whole hours drop the decimal naturally). Pure.
export function hoursLabel(hours: number): string {
  const rounded = Math.round(Math.max(0, hours) * 10) / 10;
  return `${rounded}h`;
}

// The "N of M today" count fragment shared by the notice and the card. A null max
// (#1458 — the optional "maximum doses per day" left blank) drops the ceiling half
// and reads "1 today"; the fragment never invents a max it wasn't given.
export function countFragment(
  countToday: number,
  maxDailyCount: number | null
): string {
  return maxDailyCount == null
    ? `${countToday} today`
    : `${countToday} of ${maxDailyCount} today`;
}

// The one-shot redose NOTICE message (title + body) for the fire case. The title
// names the profile (#1721 — refill.ts's convention, applied to the two dispatch-path
// builders that never had it). `lastClock` is
// the profile-local clock time of the arming administration ("4:02pm"); empty when
// unknown. Example: "6h since Ibuprofen (4:02pm) — your minimum interval has passed ·
// 2 of 4 today." `sinceName` (#1027) names the med the ARMING administration belongs
// to when a same-ingredient SIBLING's dose armed the clock — the body then reads
// honestly ("8h since Ibuprofen OTC") while the title keeps the notice's own item.
export function redoseNoticeMessage(input: {
  name: string;
  // The subject profile, named in the TITLE like every other self-attributing
  // builder (#1721). A redose notice is safety-adjacent — "whose ibuprofen interval
  // passed?" is not answerable from an unattributed message in a household chat.
  // Empty (a single-profile caller that passes none) leaves the title as it was.
  profileName?: string | null;
  amount?: string | null;
  product?: string | null;
  sinceHours: number;
  lastClock: string;
  countToday: number;
  maxDailyCount: number;
  sinceName?: string | null;
}): { title: string; body: string } {
  const at = input.lastClock ? ` (${input.lastClock})` : "";
  const since = input.sinceName?.trim() || input.name;
  const dose = formatMedicationDoseProduct(input.amount, input.product);
  // A family sibling can arm this window. Its name is known, but its product is
  // not part of this formatter input, so never attach the current item's dose to
  // a sibling name.
  const medication =
    since === input.name && dose ? `${since} · ${dose}` : since;
  const who = input.profileName?.trim() ? `${input.profileName.trim()} — ` : "";
  return {
    title: `Redose window open: ${who}${input.name}`,
    body:
      `${hoursLabel(input.sinceHours)} since ${medication}${at} — your minimum ` +
      `interval has passed · ${countFragment(input.countToday, input.maxDailyCount)}.`,
  };
}

// The marker-agnostic status line for the med card / dashboard widget, or null when
// there's nothing useful to say (nothing logged today). Never permissive — it reports
// window state and the running count, deferring to the user's judgment:
//   • at the confirmed max → "Max reached · 4 of 4 today"
//   • window open          → "Redose OK — min interval passed · 2 of 4 today"
//   • not yet              → "Next dose in ~2h · 1 of 4 today"
// With NO confirmed daily max (#1458) the ceiling half simply drops — "Next dose in
// ~5h · 1 today", "Redose OK — min interval passed · 1 today", and never "Max
// reached", because an unconfigured maximum is not a reached one.
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

// A redose window is guidance, not a hard gate: logging always remains available.
// It receives CTA emphasis only when there is no configured window yet, or when the
// confirmed interval has passed and the daily maximum has not been reached.
export function redoseActionIsPrimary(status: RedoseStatus | null): boolean {
  return status == null || (status.open && !status.atMax);
}
