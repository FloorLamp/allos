import type { Sex } from "./types";
import type { AppRoute } from "./hrefs";
import {
  PREVENTIVE_CATALOG,
  type Citation,
  type MilestoneVisitRule,
  type PreventiveKind,
  type PreventiveRule,
} from "./preventive-catalog";
import {
  everSmoked,
  lungScreeningGate,
  NO_SMOKING,
  type ResolvedSmoking,
} from "./smoking";
import {
  visitModulationFor,
  screeningModulationFor,
  type RiskFactor,
} from "./risk-stratification";

// Pure, DB-free assessment of a profile's preventive-care status against the
// curated catalog (`lib/preventive-catalog.ts`), mirroring the immunization
// status engine (`lib/immunization-status.ts` / `assessSchedule`). The caller
// resolves the profile's age (in months), sex, "today" (in the profile's
// timezone), the list of completion `satisfactions`, and any manual overrides,
// and gets back a per-rule status plus a small summary. Nothing here touches the
// DB or the clock — every input is passed in, so the whole file is unit-tested.
//
// SIMPLIFIED, informational only — not clinical advice. Satisfactions are a
// generic `(ruleKey, date)` stream so the assessor is agnostic to HOW completion
// was recorded (a manual "mark done" now, or record-inference later): both feed
// the same list. Missing birthdate (age unknown) emits NOTHING; a sex-restricted
// rule with unknown sex is likewise omitted rather than guessed.

export type PreventiveStatus =
  | "up_to_date" // done recently / on schedule / not yet in the lead window
  | "due" // recommended now (or within ~1 month of the window opening)
  | "overdue" // past the recommended point by more than the grace period
  | "setup" // in-window but NEVER RECORDED — unknown, not late (issue #1433)
  | "not_recommended"; // outside the age/sex window, risk-gated, or overridden

// The EVIDENCE a status rests on (issue #1433). An attention state has to be earned
// by evidence: `recorded` means a dated satisfaction exists and the interval from it
// genuinely elapsed; `never-recorded` means the only inputs were the profile's age
// and the catalog's nominal interval — i.e. the user told us how old they are, not
// that they missed anything.
//
// The split matters because the two read identically in the data and mean opposite
// things to a person. A 38-year-old who finished the setup wizard 30 seconds ago has
// no dental/eye/physical history on file, and calling that "Overdue" manufactures an
// obligation the system has no evidence for — which is exactly what teaches people to
// ignore the red rows that ARE earned.
export type PreventiveEvidence = "recorded" | "never-recorded";

// Which evidence an assessment's status rests on. `setup` is the ONE status derived
// with nothing on record behind it; every other status either has a `lastDate` or is
// terminal. Exported so a surface can ask the question instead of re-deriving it from
// `lastDate == null` (which is also true of the not_recommended cases).
export function preventiveEvidence(
  a: Pick<PreventiveAssessment, "status">
): PreventiveEvidence {
  return a.status === "setup" ? "never-recorded" : "recorded";
}

// The copy for the never-recorded state. One string per surface, defined here (with
// the decision) so the Upcoming row, the dashboard hero line, and any later formatter
// say the identical thing (#221) rather than each inventing a calmer phrasing.
export const PREVENTIVE_SETUP_DETAIL =
  "No record yet — add a past date or schedule";
export const PREVENTIVE_SETUP_SHORT = "No record yet";

// A per-profile manual override (issue #82's `preventive_overrides`). `declined`
// is an informed opt-out; `not_applicable` doubles as the anatomy escape hatch
// (e.g. cervical screening after hysterectomy) without new demographic modeling.
// Both drive the status to not_recommended while recording which override applied.
export type PreventiveOverrideKind = "declined" | "not_applicable";

export interface PreventiveOverride {
  ruleKey: string;
  kind: PreventiveOverrideKind;
}

// A completion event: rule `ruleKey` was satisfied on `date` (YYYY-MM-DD). For a
// visit that is a completed appointment; for a screening, a result/procedure.
export interface PreventiveSatisfaction {
  ruleKey: string;
  date: string;
}

export interface PreventiveAssessment {
  key: string;
  name: string;
  kind: PreventiveKind;
  status: PreventiveStatus;
  // Most recent satisfaction date for this rule, or null if never satisfied.
  lastDate: string | null;
  // Concrete next-due date (YYYY-MM-DD), when it can be derived from a prior
  // satisfaction + the rule's interval. Null for age-based first-time items
  // (which report an age instead) and terminal statuses.
  nextDueDate: string | null;
  // Age (in months) at which this item is next recommended, when the timing is
  // age-based (a never-satisfied screening/milestone). Null once history drives
  // a concrete `nextDueDate`, or for terminal statuses. The caller can convert
  // this to a date via the profile's birthdate — the assessor stays pure.
  nextDueAgeMonths: number | null;
  detail: string; // short human status line
  nextLabel: string | null; // upcoming hint
  // Optional destination override for the surfaced item. Null → the caller's
  // kind-based default (e.g. a screening links to the passport). Used by the
  // risk-gated lung prompt to point at Settings → Profile, where the missing
  // pack-years are entered.
  href: AppRoute | null;
  // The override in effect, if any (status is then not_recommended). Null when
  // the status is purely schedule-derived.
  override: PreventiveOverrideKind | null;
  citation: Citation; // passed through for the auditable "based on X" disclaimer
  // Risk-stratified cadence modulation: the calm, cited reason line(s) a recurring
  // VISIT rule (Substrate 3, #707) OR a SCREENING rule (hereditary-risk cadence, #711)
  // earned from the profile's risk factors (empty when none), and the within-band
  // ranking weight (0 when none). Populated only when a factor tightened the item's
  // cadence — the same modulation that brought it due sooner also explains WHY. The
  // surfacing layer joins the reasons into the item detail and lifts the priority
  // (issue #699/#706/#711).
  riskReasons: string[];
  riskPriority: number;
}

export interface PreventiveSummary {
  assessments: PreventiveAssessment[];
  // Due/overdue items only, overdue first — the EVIDENCE-BASED actionable slice.
  // This is what pushes: the proactive Telegram nudge and the reconciler are both
  // composed from it, so nothing in `setup` can ever page anyone (issue #1433).
  actionable: PreventiveAssessment[];
  // In-window rules with NOTHING on record (issue #1433). Not actionable — there is
  // no evidence anything was missed — but not silent either: they are the profile's
  // "tell us what you've already had" list, surfaced as a calm, collapsed setup
  // affordance. Catalog order.
  setup: PreventiveAssessment[];
  dueCount: number;
  overdueCount: number;
  setupCount: number;
}

// Surface a due item about a month before its window opens (issue: "due items
// surface ~1 month before the window").
const LEAD_MONTHS = 1;

// Add whole months to a YYYY-MM-DD date (pure; clamps to the target month's last
// day, e.g. Jan 31 + 1mo → Feb 28/29). Returns the input unchanged if unparseable.
export function addMonths(date: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  let total = +m[2] - 1 + months;
  const y = +m[1] + Math.floor(total / 12);
  const mo = ((total % 12) + 12) % 12;
  const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const d = Math.min(+m[3], daysInMonth);
  return `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// The most recent satisfaction date per rule key (ISO dates compare lexically).
export function lastByRule(
  satisfactions: PreventiveSatisfaction[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of satisfactions) {
    if (!s.date) continue;
    const prev = map.get(s.ruleKey);
    if (prev == null || s.date > prev) map.set(s.ruleKey, s.date);
  }
  return map;
}

function make(
  rule: PreventiveRule,
  status: PreventiveStatus,
  detail: string,
  extra: Partial<PreventiveAssessment> = {}
): PreventiveAssessment {
  return {
    key: rule.key,
    name: rule.name,
    kind: rule.kind,
    status,
    lastDate: null,
    nextDueDate: null,
    nextDueAgeMonths: null,
    detail,
    nextLabel: null,
    href: null,
    override: null,
    citation: rule.citation,
    riskReasons: [],
    riskPriority: 0,
    ...extra,
  };
}

interface Ctx {
  ageMonths: number;
  sex: Sex | null;
  today: string;
  year: number; // calendar year of `today`, for the lung-screening recency window
  smoking: ResolvedSmoking; // resolved smoking facts for the risk-gated rules
  // The profile's active risk factors (Substrate 3, #707) — modulate recurring
  // visit cadence. Empty set → visits keep their catalog cadence untouched.
  riskFactors: ReadonlySet<RiskFactor>;
  lastByRule: Map<string, string>;
}

// Assess one rule that carries a from-last recurrence (recurring visit or
// interval screening) OR a first-time age-based recommendation. `startMonths`
// is the age it first applies; `intervalMonths` (when present) is the rescreen
// cadence from the last satisfaction.
function assessRecurring(
  rule: PreventiveRule,
  ctx: Ctx,
  startMonths: number,
  endMonths: number | undefined,
  intervalMonths: number | undefined
): PreventiveAssessment {
  const last = ctx.lastByRule.get(rule.key) ?? null;
  const grace = rule.graceMonths;

  // Risk-driven cadence modulation. A recurring VISIT rule tightens via
  // visitModulationFor (Substrate 3, #707); a SCREENING rule tightens via
  // screeningModulationFor when a hereditary-risk factor targets it (#711 — a BRCA →
  // mammography / Lynch → colorectal cadence rule). Both bring the item due sooner and
  // carry the calm, cited reason. Computed once here (independent of `last`) so it
  // rides both the interval recurrence AND the never-satisfied age-based due state.
  // A screening's priority-only `screeningRules` ranking (family-history → lipid) stays
  // a SEPARATE, additive dimension applied downstream via screeningPriorityFor. No-op
  // (multiplier 1, no reasons) when nothing matched, leaving the catalog cadence intact.
  const visitMod =
    rule.kind === "visit"
      ? visitModulationFor(rule.key, ctx.riskFactors)
      : rule.kind === "screening"
        ? screeningModulationFor(rule.key, ctx.riskFactors)
        : { multiplier: 1, priority: 0, reasons: [] as string[] };
  const riskExtra: Partial<PreventiveAssessment> =
    visitMod.reasons.length > 0
      ? { riskReasons: visitMod.reasons, riskPriority: visitMod.priority }
      : {};

  // Aged out of the routine window (above end age). Screenings past their end
  // age are individualized rather than routine; recurring visits hand off.
  if (endMonths != null && ctx.ageMonths >= endMonths) {
    const endYears = Math.floor(endMonths / 12);
    return make(
      rule,
      "not_recommended",
      last
        ? `Last done ${last}; routine screening typically ends around age ${endYears}`
        : `Routine window ends around age ${endYears}`,
      { lastDate: last }
    );
  }

  // Too young — not yet in the window (report the entry age).
  if (ctx.ageMonths < startMonths - LEAD_MONTHS) {
    return make(
      rule,
      "not_recommended",
      `Recommended from age ${Math.floor(startMonths / 12)}`,
      { nextDueAgeMonths: startMonths }
    );
  }

  if (last == null) {
    // NEVER RECORDED, in (or ~1mo before) the window (issue #1433). The inputs are
    // the profile's age and the catalog's nominal interval — and NOTHING else. That
    // is not evidence of a missed screening, it is the absence of history, so the
    // status is `setup`, not due/overdue.
    //
    // This branch used to split on `ageMonths >= startMonths + grace` into due →
    // "Recommended" and overdue → "Overdue — none on record". Both readings were
    // manufactured: the grace period is measured from an age the user just typed in,
    // so a brand-new 38-year-old profile opened on ~12 red "Overdue — none on record"
    // rows before any data existed. The split is gone rather than softened, because a
    // never-recorded item that RIPENS from "due" into a calmer state as time passes
    // would be a strictly worse description of the same zero evidence.
    //
    // `grace` and the entry age still ride out on `nextDueAgeMonths`, so a surface
    // that wants to say WHEN the window opened still can — it just cannot call it
    // late. (Well-child milestones keep their own due/overdue window in
    // assessMilestone: those lapse out of a narrow, dated window rather than
    // accumulating forever, so the same reasoning does not apply.)
    return make(rule, "setup", PREVENTIVE_SETUP_SHORT, {
      nextDueAgeMonths: startMonths,
      nextLabel: PREVENTIVE_SETUP_DETAIL,
      ...riskExtra,
    });
  }

  // A once-in-window screening (no interval): a prior result satisfies it for good.
  if (intervalMonths == null) {
    return make(rule, "up_to_date", `Done ${last}`, {
      lastDate: last,
      nextLabel: "One-time — complete",
    });
  }

  // Interval recurrence: the clock runs from the last satisfaction, modulated (for a
  // visit rule) by the matched risk factors — the tightest multiplier wins, rounded
  // to whole months and floored at 1 so the from-last date math stays clean.
  const effectiveInterval =
    visitMod.multiplier < 1
      ? Math.max(1, Math.round(intervalMonths * visitMod.multiplier))
      : intervalMonths;
  const dueDate = addMonths(last, effectiveInterval);
  const leadDate = addMonths(last, effectiveInterval - LEAD_MONTHS);
  const overdueDate = addMonths(last, effectiveInterval + grace);
  if (ctx.today < leadDate) {
    return make(rule, "up_to_date", `Done ${last}`, {
      lastDate: last,
      nextDueDate: dueDate,
      nextLabel: `Next by ${dueDate}`,
      ...riskExtra,
    });
  }
  if (ctx.today < overdueDate) {
    return make(rule, "due", `Last done ${last}`, {
      lastDate: last,
      nextDueDate: dueDate,
      nextLabel: `Due by ${dueDate}`,
      ...riskExtra,
    });
  }
  return make(rule, "overdue", `Last done ${last}`, {
    lastDate: last,
    nextDueDate: dueDate,
    nextLabel: `Was due ${dueDate}`,
    ...riskExtra,
  });
}

// Assess a one-time well-child milestone. Satisfied → done; otherwise a window
// around the target age: due from ~1mo before, overdue after the grace period,
// and lapsed (not_recommended) once the child is past the milestone's window
// (the later milestones carry the schedule forward).
function assessMilestone(
  rule: MilestoneVisitRule,
  ctx: Ctx
): PreventiveAssessment {
  const { atMonths, endMonths, ageLabel } = rule.schedule;
  const last = ctx.lastByRule.get(rule.key) ?? null;
  if (last != null) {
    return make(rule, "up_to_date", `Completed ${last}`, { lastDate: last });
  }
  if (ctx.ageMonths < atMonths - LEAD_MONTHS) {
    return make(rule, "up_to_date", `Recommended around ${ageLabel}`, {
      nextDueAgeMonths: atMonths,
      nextLabel: `Around ${ageLabel}`,
    });
  }
  if (ctx.ageMonths >= endMonths) {
    return make(rule, "not_recommended", `Visit window (${ageLabel}) passed`, {
      nextDueAgeMonths: atMonths,
    });
  }
  const overdue = ctx.ageMonths >= atMonths + rule.graceMonths;
  return make(
    rule,
    overdue ? "overdue" : "due",
    overdue ? `${ageLabel} visit overdue` : `${ageLabel} visit due`,
    { nextDueAgeMonths: atMonths, nextLabel: `${ageLabel} well-child visit` }
  );
}

// The pure schedule assessment (age/interval), ignoring any risk gate.
function assessSchedule(rule: PreventiveRule, ctx: Ctx): PreventiveAssessment {
  const s = rule.schedule;
  if (s.type === "milestone") {
    return assessMilestone(rule as MilestoneVisitRule, ctx);
  }
  // recurring + screening share the from-last / age-based recurrence engine.
  return assessRecurring(
    rule,
    ctx,
    s.startMonths,
    s.endMonths,
    s.intervalMonths
  );
}

// Where the risk-gated lung prompt sends the user to fill in the missing input —
// smoking history moved to the Medical → Background surface (#928).
const SMOKING_SETTINGS_HREF: AppRoute = "/records/care/overview";

// Assess a risk-gated rule (issue #83) against the resolved smoking facts. Age/sex
// still gate first: the schedule assessment runs, and if the profile is OUTSIDE the
// age window (or the sex mismatch already handled upstream), that verdict stands —
// a 30-year-old ever-smoker is never prompted for lung screening. Only WITHIN the
// window does the smoking gate decide, activating the rule that shipped inert.
function assessRiskGated(rule: PreventiveRule, ctx: Ctx): PreventiveAssessment {
  const schedule = assessSchedule(rule, ctx);
  // Outside the routine age window → the age gate wins; smoking is moot.
  if (schedule.status === "not_recommended") return schedule;

  const s = ctx.smoking;
  if (rule.key === "aaa_ultrasound") {
    if (everSmoked(s)) return schedule;
    return make(
      rule,
      "not_recommended",
      s.source == null
        ? "No smoking history on file — recommended only for those who have ever smoked"
        : "Recommended only for those who have ever smoked"
    );
  }
  if (rule.key === "lung_cancer_ldct") {
    const gate = lungScreeningGate(s, ctx.year);
    if (gate === "eligible") return schedule;
    if (gate === "needs_info") {
      // An ever-smoker with unknown pack-years / quit year: surface a PROMPT to
      // finish the record (linking to Settings) rather than silently gating out.
      return make(
        rule,
        "due",
        "Add your pack-years to check lung screening eligibility",
        { href: SMOKING_SETTINGS_HREF, nextLabel: "Add smoking details" }
      );
    }
    return make(
      rule,
      "not_recommended",
      s.everSmoked
        ? "Below the pack-year / recency threshold for lung screening"
        : "No qualifying smoking history on file"
    );
  }
  // Unknown risk-gated rule — stay inert (defensive; no such rule ships today).
  return make(
    rule,
    "not_recommended",
    "Depends on risk factors not yet recorded"
  );
}

function assessOne(rule: PreventiveRule, ctx: Ctx): PreventiveAssessment {
  if (rule.riskGated) return assessRiskGated(rule, ctx);
  return assessSchedule(rule, ctx);
}

// Resolve a manual override on top of a schedule-derived assessment (pure). Both
// kinds drop the item out of the due/overdue actionable set and read
// not_recommended, recording which override applied. Returns the assessment
// unchanged when there is no override for its rule.
export function applyPreventiveOverride(
  a: PreventiveAssessment,
  override: PreventiveOverride | undefined
): PreventiveAssessment {
  if (!override) return a;
  return {
    ...a,
    status: "not_recommended",
    override: override.kind,
    detail: override.kind === "declined" ? "Declined" : "Marked not applicable",
    nextDueDate: null,
    nextDueAgeMonths: null,
    nextLabel: null,
  };
}

export interface PreventiveInput {
  ageMonths: number | null;
  sex: Sex | null;
  satisfactions: PreventiveSatisfaction[];
  overrides?: PreventiveOverride[];
  // Resolved smoking facts (issue #83) for the risk-gated rules. Omitted → the
  // rules stay inert (NO_SMOKING), preserving the pre-#83 behavior for any caller
  // that doesn't resolve smoking.
  smoking?: ResolvedSmoking;
  // The profile's active risk factors (Substrate 3, #707) — modulate recurring visit
  // cadence (a diabetic profile's eye/dental visits come due sooner, with a reason).
  // Omitted → empty set → visits keep their catalog cadence (pre-#707 behavior for
  // any caller that doesn't gather risk factors).
  riskFactors?: ReadonlySet<RiskFactor>;
  today: string;
}

// Assess a profile against the catalog. Returns per-rule assessments plus the
// actionable (due/overdue) slice. Missing age → emits nothing (no guesses). A
// sex-restricted rule with unknown sex is omitted, not guessed.
export function assessPreventiveCare(
  rules: PreventiveRule[],
  input: PreventiveInput
): PreventiveSummary {
  const empty: PreventiveSummary = {
    assessments: [],
    actionable: [],
    setup: [],
    dueCount: 0,
    overdueCount: 0,
    setupCount: 0,
  };
  if (input.ageMonths == null) return empty;

  const ctx: Ctx = {
    ageMonths: input.ageMonths,
    sex: input.sex,
    today: input.today,
    year: Number(input.today.slice(0, 4)) || 0,
    smoking: input.smoking ?? NO_SMOKING,
    riskFactors: input.riskFactors ?? new Set<RiskFactor>(),
    lastByRule: lastByRule(input.satisfactions),
  };
  const overrideByKey = new Map(
    (input.overrides ?? []).map((o) => [o.ruleKey, o])
  );

  const assessments: PreventiveAssessment[] = [];
  for (const rule of rules) {
    // Sex-restricted rule with a mismatched sex → not recommended. With unknown
    // sex → omit entirely (no guess).
    if (rule.sex) {
      if (ctx.sex == null) continue;
      if (ctx.sex !== rule.sex) {
        assessments.push(
          make(rule, "not_recommended", `Recommended for ${rule.sex} profiles`)
        );
        continue;
      }
    }
    assessments.push(
      applyPreventiveOverride(assessOne(rule, ctx), overrideByKey.get(rule.key))
    );
  }

  const actionable = assessments
    .filter((a) => a.status === "due" || a.status === "overdue")
    .sort((a, b) => {
      // Overdue before due; then stable by catalog order (index).
      if (a.status !== b.status) return a.status === "overdue" ? -1 : 1;
      return 0;
    });
  // The never-recorded slice (#1433), kept OUT of `actionable` on purpose: every
  // consumer of `actionable` (the nudge, the reconciler, the Upcoming date bands) is
  // a place where an item asserts lateness, and these assert nothing of the kind.
  const setup = assessments.filter((a) => a.status === "setup");
  return {
    assessments,
    actionable,
    setup,
    dueCount: assessments.filter((a) => a.status === "due").length,
    overdueCount: assessments.filter((a) => a.status === "overdue").length,
    setupCount: setup.length,
  };
}

// Convenience wrapper against the bundled catalog.
export function assessCatalog(input: PreventiveInput): PreventiveSummary {
  return assessPreventiveCare(PREVENTIVE_CATALOG, input);
}
