// Pure formatters for the PRN redose notice (#798) — no DB/network, unit-tested in
// lib/__tests__/redose-format.test.ts. Shared by the notify orchestrator (the
// Telegram/push body) and the on-page surfacing (the med card + dashboard widget), so
// every surface phrases the SAME redose state identically ("one question, one
// computation"). INFORMATIONAL only: the copy states elapsed time against the user's
// OWN confirmed numbers — never "you can take more".

import type {
  PrnDayExposure,
  PrnExposureBasis,
  RedoseStatus,
} from "./prn-redose";
import { formatMedicationDoseProduct } from "./medication-dose-format";
import { GLYPH } from "./notifications/glyphs";

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

// A milligram value for copy: at most one decimal place, no trailing ".0".
export function mgLabel(mg: number): string {
  return String(Math.round(mg * 10) / 10);
}

// The "N of M" fragment on whatever basis the day's exposure was HONESTLY
// computable on (#1854): milligrams when the amount-aware ceiling applied
// ("1200 of 2400 mg today", "at least 1600 of 2400 mg today" when some doses
// carried no parseable amount), else the plain administration count. One
// formatter so the card, the widget, the Telegram list and the redose notice
// state the same basis — and never imply mg precision the day doesn't have.
export function exposureFragment(
  exposure: PrnDayExposure | null,
  countToday: number,
  maxDailyCount: number | null
): string {
  if (!exposure || exposure.basis === "count") {
    return countFragment(countToday, maxDailyCount);
  }
  const lead = exposure.unknownAmounts > 0 ? "at least " : "";
  return `${lead}${mgLabel(exposure.total)} of ${mgLabel(exposure.max)} mg today`;
}

// The one-shot redose NOTICE message (title + body) for the fire case. The title
// names the profile (#1721 — refill.ts's convention, applied to the two dispatch-path
// builders that never had it). `lastClock` is the profile-local time of the arming
// administration ("4:02pm" today, "Jul 14, 2026 at 4:02pm" on another day); empty when
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
  // The day's amount-aware exposure (#1854); the count fragment then reads
  // milligrams on the same basis the ceiling was judged on. Absent/null keeps
  // the plain count.
  exposure?: PrnDayExposure | null;
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
    title: `${GLYPH.dose} Redose window open: ${who}${input.name}`,
    body:
      `${hoursLabel(input.sinceHours)} since ${medication}${at} — your minimum ` +
      `interval has passed · ${exposureFragment(
        input.exposure ?? null,
        input.countToday,
        input.maxDailyCount
      )}.`,
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
  const count = exposureFragment(
    status.exposure,
    status.countToday,
    status.maxDailyCount
  );
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

// ---- The `/dose` quick-log list (issue #1717) -------------------------------------
//
// The Telegram list rendered `💊 Ibuprofen · 200 mg (2 today)` — a BARE, ITEM-ONLY
// count — while the gather already carried the interval, the confirmed max and the
// ingredient-family counters, and the in-app card rendered the verdict from exactly
// those fields. The surface with the least context did the least checking: a tap could
// pass the confirmed daily max with no warning, and a family-fed counter read "1 today"
// where the app said "3 of 4 today across 2 items".
//
// One verdict formatter (#221): the list label and the card label are the SAME
// classification, so Telegram can never be laxer than the app.

// The button label for one PRN med in the `/dose` list. `prefix` disambiguates a
// multi-profile chat; `dose` is the pre-formatted amount ("200 mg"). The verdict half
// is `redoseCardLabel` verbatim — "Max reached · 4 of 4 today", "Next dose in ~2h · 1
// of 4 today" — falling back to the plain count fragment when there is no window to
// report, and to nothing at all when nothing has been logged today. countFragment's
// discipline holds throughout: a null max renders "2 today", never "Max reached".
export function prnQuickLogLabel(input: {
  name: string;
  prefix?: string;
  dose?: string | null;
  status: RedoseStatus | null;
  countToday: number;
  maxDailyCount: number | null;
  familyMemberCount?: number;
}): string {
  const members = input.familyMemberCount ?? 1;
  const head = `${input.prefix ?? ""}${input.name}${input.dose ? ` · ${input.dose}` : ""}`;
  const verdict =
    redoseCardLabel(input.status, members) ??
    (input.countToday > 0
      ? `${countFragment(input.countToday, input.maxDailyCount)}${
          members > 1 ? ` across ${members} items` : ""
        }`
      : null);
  return verdict ? `${head} — ${verdict}` : head;
}

// The Telegram toast after a `/dose` tap. The write outcome comes first (never an
// unconditional confirm — the AdministrationOutcome contract), and a LOGGED tap then
// states the verdict that now stands, computed from post-write state by the same
// classification the card shows. That is what makes an at-max tap honest: the app
// treats a redose window as guidance rather than a gate, so Telegram logs it too —
// but it says "Max reached · 5 of 4 today" instead of a bare "Logged ✅".
export function prnLogAnswerText(
  base: string,
  logged: boolean,
  status: RedoseStatus | null,
  familyMemberCount = 1
): string {
  if (!logged) return base;
  const verdict = redoseCardLabel(status, familyMemberCount);
  return verdict ? `${base} · ${verdict}` : base;
}

// ---- The over-max care finding's detail line (#798 / #1027 / #1854) ---------
//
// One formatter for the `prn-max:<itemId>` finding so every surface it reaches
// (Upcoming, the attention hero, the digest) phrases the SAME verdict — and
// states the BASIS it was computed on. Milligrams read "2400 mg logged today …
// max of 1200 mg per day" (with an honest "At least" lead when some doses had no
// recorded amount — the mg lower bound that is already past the ceiling); the
// count fallback reads "5 doses logged today … max of 4 per day", never implying
// mg precision the day's amounts don't carry. A multi-item family names every
// member (#531 — label by what the count spans).
export function prnOverMaxDetail(input: {
  basis: PrnExposureBasis;
  total: number;
  max: number;
  unknownAmounts: number;
  memberNames?: string[];
}): string {
  const mg = input.basis === "mg";
  const logged = mg
    ? `${input.unknownAmounts > 0 ? "At least " : ""}${mgLabel(input.total)} mg ` +
      `logged today` +
      (input.unknownAmounts > 0
        ? ` (${input.unknownAmounts} ${
            input.unknownAmounts === 1 ? "dose" : "doses"
          } had no recorded amount)`
        : ` (summed from your logged dose amounts)`)
    : `${input.total} ${input.total === 1 ? "dose" : "doses"} logged today`;
  const ceiling = mg
    ? `${mgLabel(input.max)} mg per day`
    : `${input.max} per day`;
  const vs = input.memberNames?.length
    ? `across ${input.memberNames.join(" + ")} vs the most conservative ` +
      `confirmed max of ${ceiling}`
    : `vs your confirmed max of ${ceiling}`;
  return (
    `${logged} ${vs}. Informational — if this looks wrong, adjust the log; ` +
    `if you're in pain, contact your clinician.`
  );
}
