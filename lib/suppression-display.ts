// The ONE dedupeKey → display resolver for the findings-suppression bus
// (issue #1151). Upcoming's "Snoozed & dismissed" section now aggregates EVERY
// active suppression row in `upcoming_dismissals` — care/attention items,
// coaching/observational findings, and the per-surface suggestions — not just
// the care tier. The care tier keeps its rich reconstruction (a live
// UpcomingItem); everything else resolves here, from the key's PREFIX, into a
// domain group + a human label (#221: one resolver, so the central section and
// the origin surfaces can't disagree about what a silenced key means).
//
// Pure (string templates over key namespaces, no DB), so the label rules are
// unit-testable and the prefix-coverage guard
// (lib/__tests__/suppression-display.test.ts) can assert every registered
// finding namespace has a mapping — a NEW finding engine can't ship a key that
// renders un-displayable in the central view (the #448/#203 registry-guard
// pattern applied to labels).
//
// Orphan discipline (#203): a suppression whose subject is gone (deleted row,
// renamed name-keyed subject) or whose namespace is unknown resolves to the
// generic ORPHAN_SUPPRESSION_LABEL row — its Restore simply clears the dead key
// (lets the user prune stale suppressions), never a crash.

import {
  RULE_FINDING_REGISTRY,
  type RuleFindingRegistryEntry,
} from "./rule-finding-prefixes";
import { MED_BRIDGE_PREFIX } from "./medication-record-match";
import { DORMANT_PRN_PREFIX } from "./dormant-prn";
import { FOOD_TIMING_PREFIX } from "./food-drug-interactions";
import { KEEP_APART_PREFIX } from "./intake-pairs";
import { WEATHER_MED_PREFIX } from "./weather-med-safety";
import { OUTDOOR_PLAN_PREFIX } from "./queries/weather-training";
import { CONDITION_CONSIDERATION_PREFIX } from "./condition-training-considerations";
import { SURGERY_BRIDGE_PREFIX } from "./surgery-bridge";
import {
  STREAM_OFFBOARD_PREFIX,
  STREAM_ONBOARD_PREFIX,
} from "./integrations/stream-lifecycle";
import { STEPS_PACE_PREFIX } from "./steps-target";
import { PR_CARDIO_PREFIX, PR_STRENGTH_PREFIX } from "./dismissal-keys";
import { formatNotifyTime } from "./notifications/schedule";

// The domain GROUP a suppressed row renders under — the section's sub-headings.
export type SuppressionDomain =
  | "Due & scheduled"
  | "Warnings"
  | "Biomarkers"
  | "Care"
  | "Coaching"
  | "Suggestions"
  | "Other";

export interface SuppressedKeyDisplay {
  domain: SuppressionDomain;
  label: string;
}

// The generic display for a key no resolver entry recognizes, or whose subject
// no longer exists — restorable only in the sense that Restore clears the row.
export const ORPHAN_SUPPRESSION_LABEL = "Dismissed item (no longer applies)";

export function orphanSuppressionDisplay(): SuppressedKeyDisplay {
  return { domain: "Other", label: ORPHAN_SUPPRESSION_LABEL };
}

// Capitalize each word of a subject parsed out of a lowercased key so it reads
// as a name ("bench press" → "Bench Press"). Keys store subjects lowercased;
// the original casing is gone, so title case is the honest approximation.
function titleize(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// One resolver entry: the key namespace it owns and the label template over the
// key's tail (the part after the prefix).
interface ResolverEntry {
  prefix: string;
  domain: SuppressionDomain;
  label: (tail: string) => string;
}

// Tail helpers. `part(tail, i)` = the i-th ':'-separated segment, "" when absent.
function part(tail: string, i: number): string {
  return tail.split(":")[i] ?? "";
}

// Labels for the RULE_FINDING_REGISTRY namespaces (coaching + care builders).
// Each parses the subject out of the key where one is embedded — e.g.
// `training-obs:plateau:<name>` → "Plateau — <Name>" — and falls back to a
// domain-generic label otherwise. Keyed by prefix so the coverage guard can
// assert 1:1 with the registry.
const REGISTRY_LABELS: Record<string, (tail: string) => string> = {
  "training-obs:": (t) => {
    const kind = part(t, 0);
    const name = titleize(part(t, 1));
    if (kind === "plateau") return name ? `Plateau — ${name}` : "Lift plateau";
    if (kind === "stale")
      return name ? `Stale exercise — ${name}` : "Stale exercise";
    if (kind === "balance") return "Push/pull balance";
    return "Training observation";
  },
  "muscle-volume:": (t) => {
    const muscle = titleize(part(t, 1));
    return muscle ? `Low training volume — ${muscle}` : "Training volume note";
  },
  "body-hygiene:": () => "Body-data check (probable entry error)",
  "goal-pace:": (t) =>
    part(t, 0) === "weight-loss-rate"
      ? "Weight-loss rate caution"
      : "Goal pacing note",
  "adherence:": () => "Supplement adherence pattern",
  // #1505: keyed on the ITEM id, so there is no name in the key to render — the
  // label names the decision instead ("you chose to keep the current priority").
  "demote-obligation:": () => "Obligation demotion suggestion",
  // #1670: keyed on the TARGET id, so there is no name in the key to render — the
  // label names the decision instead ("you chose to keep the weekly target").
  "right-size:": () => "Weekly-target right-sizing suggestion",
  "food-suggest:": (t) => {
    const n = titleize(t.replace(/[_-]/g, " "));
    return n ? `Food suggestion — ${n}` : "Food suggestion";
  },
  "food-reduce:": (t) => {
    const n = titleize(t.replace(/[_-]/g, " "));
    return n ? `Cut-back suggestion — ${n}` : "Cut-back suggestion";
  },
  "food-habit:": (t) => {
    const n = titleize(t.replace(/[_-]/g, " "));
    return n ? `Food habit — ${n}` : "Food habit";
  },
  // #2021: `<intakeItemId>:<curatedRuleId>:<date>` and `<intakeItemId>:<curatedRuleId>`.
  // Neither tail carries a name to render (the item is an id, the rule a curated slug),
  // so the label names the topic — and deliberately does NOT restate what was eaten: a
  // silenced food–drug note should read as calmly here as it did where it was dismissed.
  "food-drug-event:": () => "Food–drug note",
  "food-drug-variance:": () => "Food–drug steadiness note",
  "substance-use:": (t) => {
    const n = titleize(part(t, 1).replace(/[_-]/g, " "));
    return n ? `Substance note — ${n}` : "Substance note";
  },
  "protein-adequacy:": () => "Protein adequacy note",
  "fiber-adequacy:": () => "Fiber adequacy note",
  "endurance:": (t) => {
    const n = titleize(part(t, 1).replace(/[_-]/g, " "));
    return n ? `Endurance plan — ${n}` : "Endurance plan note";
  },
  "sun-exposure:": () => "Sun & daylight note",
  "oral-health:": () => "Oral health note",
  "fitness-check:": () => "Fitness check due",
  "mobility-suggest:": (t) => {
    const region = titleize(part(t, 1).replace(/[_-]/g, " "));
    return region ? `Mobility suggestion — ${region}` : "Mobility suggestion";
  },
  "cycle-bleeding:": (t) =>
    part(t, 0) ? `Long period — ${part(t, 0)}` : "Long-period note",
  // #1680: keyed on the DECLARED trying-to-conceive start. The label names the
  // topic without restating the elapsed months — a silenced fertility prompt
  // should read as calmly here as it did where it was dismissed.
  "ttc-workup:": () => "Fertility conversation suggestion",
  "mood-obs:": () => "Mood observation",
  "sleep-mood:": () => "Sleep & mood observation",
  "med-dup:": (t) => {
    const n = titleize(part(t, 0).replace(/[_-]/g, " "));
    return n ? `Duplicate ingredient — ${n}` : "Duplicate-ingredient note";
  },
  "data-quality:": (t) => {
    const n = titleize(t.replace(/[_-]/g, " "));
    return n ? `Data quality — ${n}` : "Data quality gap";
  },
  "poor-sleep-override:": (t) =>
    part(t, 0)
      ? `Poor-sleep context off — ${part(t, 0)}`
      : "Poor-sleep context off",
  // A portal sync request (#1757), keyed `portal-sync:<portal>/<account>:<day>`. The
  // portal slug is the only nameable part — the account is a household nickname and the
  // day is the ask's anchor — so the label names the portal and leaves it there.
  "portal-sync:": (t) => {
    const portal = titleize(part(t, 0).split("/")[0].replace(/[_-]/g, " "));
    return portal ? `Portal sync request — ${portal}` : "Portal sync request";
  },
  // A records-recency ask (#2164/#2176), keyed `records-recency:<source>:<frontier>`.
  // The SOURCE is the nameable part; the frontier is the episode anchor, and quoting a
  // date back at someone who silenced an ask about that date adds nothing.
  "records-recency:": (t) => {
    const head = part(t, 0);
    if (head === "clinical-records") return "Lab results recency";
    if (head === "archive") {
      const provider = titleize(part(t, 1).replace(/[_-]/g, " "));
      return provider ? `Archive refresh — ${provider}` : "Archive refresh";
    }
    return "Records recency";
  },
  // The digest time suggestion (#2217), keyed `digest-time:<configured>:<proposed>`
  // in minutes of day. Both numbers are nameable and both matter: the row has to say
  // which send time the dismissal was about, because changing that time re-arms the
  // suggestion on its own.
  "digest-time:": (t) => {
    const configured = Number(part(t, 0));
    const proposed = Number(part(t, 1));
    return Number.isInteger(configured) && Number.isInteger(proposed)
      ? `Digest time suggestion — ${formatNotifyTime(configured)} → ${formatNotifyTime(proposed)}`
      : "Digest time suggestion";
  },
  // A household member's setup row (#2173), keyed on the FAILING CHECK SET
  // (`household-setup:never-onboarded+undosed-items`). The set IS the episode, so the
  // label names how many checks the dismissal covered rather than quoting ids back.
  "household-setup:": (t) => {
    const n = t.split("+").filter(Boolean).length;
    return n > 1 ? `Member setup — ${n} checks` : "Member setup";
  },
  "illness-care:": () => "Illness care reminder",
  "temp-red-flag:": () => "Temperature red flag",
  "condition-review:": () => "Condition suggestion",
  "followup:": () => "Finding follow-up",
  "mental-health:": () => "Mental-health check-in",
};

// The tier → domain group for registry namespaces.
function registryDomain(e: RuleFindingRegistryEntry): SuppressionDomain {
  return e.tier === "care" ? "Care" : "Coaching";
}

// Non-registry namespaces: the care/attention keys the Upcoming generators emit
// (rich when live; these labels serve the ORPHANED remainder), the intake-surface
// warnings, the biomarker keys, and the per-surface suggestions. Id-keyed
// subjects can't be named purely, so those get honest domain-generic labels.
const EXTRA_ENTRIES: ResolverEntry[] = [
  // ---- Due & scheduled (Upcoming care tier) --------------------------------
  { prefix: "dose:", domain: "Due & scheduled", label: () => "Scheduled dose" },
  { prefix: "refill:", domain: "Due & scheduled", label: () => "Refill nudge" },
  {
    // A declined `may` availability offer (#1505). Not in RULE_FINDING_REGISTRY for
    // the same reason `refill:` isn't — it is an Upcoming domain key, not a rule
    // builder's — but it must still be NAMEABLE here, or declining an offer would
    // leave an unlabelled row in Snoozed & dismissed with no way to restore it.
    prefix: "available:",
    domain: "Due & scheduled",
    label: () => "Available item",
  },
  {
    // Shared supply pool low-stock (#1374). Registered HERE and not in
    // RULE_FINDING_REGISTRY for the same reason `refill:` isn't: it is an Upcoming
    // GENERATOR key, not a rule-findings builder output — the registry's reflection
    // guards read builder output, and a namespace no builder emits would fail them
    // (the surgery-bridge precedent). Id-keyed, so the label is domain-generic.
    prefix: "pool-refill:",
    domain: "Due & scheduled",
    label: () => "Shared-supply refill nudge",
  },
  {
    prefix: "appointment:",
    domain: "Due & scheduled",
    label: () => "Appointment",
  },
  {
    prefix: "screening:",
    domain: "Due & scheduled",
    label: (t) => {
      const n = titleize(part(t, 0).replace(/[_-]/g, " "));
      return n ? `Screening — ${n}` : "Preventive screening";
    },
  },
  {
    prefix: "visit:",
    domain: "Due & scheduled",
    label: (t) => {
      const n = titleize(part(t, 0).replace(/[_-]/g, " "));
      return n ? `Preventive visit — ${n}` : "Preventive visit";
    },
  },
  {
    prefix: "immunization:",
    domain: "Due & scheduled",
    label: (t) => {
      const code = part(t, 0).toUpperCase();
      return code ? `Immunization — ${code}` : "Immunization";
    },
  },
  {
    prefix: "careplan:",
    domain: "Due & scheduled",
    label: () => "Care plan item",
  },
  { prefix: "goal:", domain: "Due & scheduled", label: () => "Goal check-in" },
  {
    prefix: "training:",
    domain: "Due & scheduled",
    label: () => "Training target",
  },
  {
    // The outdoor-session planning item (#1724 part 5) — "Saturday is the best window
    // for your ride". Calm and weekly, keyed per (activity, week start) so declining
    // this week's plan never silences next week's.
    prefix: OUTDOOR_PLAN_PREFIX,
    domain: "Due & scheduled",
    label: () => "Outdoor session plan",
  },
  {
    // Wellness-practice weekly target (#1259): the Upcoming twin of the pace-aware
    // Telegram nudge — dismiss once silences both (the #227 workout-nudge pattern).
    prefix: "practice:",
    domain: "Due & scheduled",
    label: () => "Practice target",
  },
  {
    prefix: "endurance-event:",
    domain: "Due & scheduled",
    label: () => "Endurance event",
  },
  {
    // The afternoon steps-pace observation (#1221), keyed per DAY. It rides the bus
    // like any Upcoming item but had no resolver entry, so a dismissed one rendered
    // as the generic orphan row in the central view — restorable but unnameable.
    prefix: STEPS_PACE_PREFIX,
    domain: "Due & scheduled",
    label: () => "Steps pace note",
  },
  {
    prefix: "med-monitor:",
    domain: "Due & scheduled",
    label: () => "Medication monitoring",
  },
  // ---- Biomarkers ----------------------------------------------------------
  {
    prefix: "biomarker-flag:",
    domain: "Biomarkers",
    label: (t) => {
      const n = titleize(t);
      return n ? `Flagged result — ${n}` : "Flagged result";
    },
  },
  {
    prefix: "biomarker:",
    domain: "Biomarkers",
    label: (t) => {
      const n = titleize(t);
      return n ? `Retest — ${n}` : "Biomarker retest";
    },
  },
  {
    prefix: "trajectory:",
    domain: "Biomarkers",
    label: (t) => {
      const n = titleize(part(t, 0));
      return n ? `Trajectory — ${n}` : "Trajectory note";
    },
  },
  // ---- Warnings (intake-surface observations) ------------------------------
  { prefix: "prn-max:", domain: "Warnings", label: () => "PRN daily-max note" },
  {
    prefix: "dietary-limit:",
    domain: "Warnings",
    label: (t) => {
      const n = titleize(t.replace(/[_-]/g, " "));
      return n ? `Upper-limit warning — ${n}` : "Upper-limit warning";
    },
  },
  {
    prefix: "rda-adequacy:",
    domain: "Warnings",
    label: (t) => {
      const n = titleize(t.replace(/[_-]/g, " "));
      return n ? `Intake adequacy — ${n}` : "Intake adequacy note";
    },
  },
  {
    prefix: "interaction:",
    domain: "Warnings",
    label: () => "Drug interaction warning",
  },
  { prefix: "pgx:", domain: "Warnings", label: () => "Pharmacogenomic note" },
  {
    prefix: "allergy-med:",
    domain: "Warnings",
    label: () => "Drug-allergy warning",
  },
  {
    prefix: "contrast:",
    domain: "Warnings",
    label: () => "Contrast safety note",
  },
  {
    prefix: "dental-safety:",
    domain: "Warnings",
    label: () => "Dental safety note",
  },
  { prefix: "ototoxic:", domain: "Warnings", label: () => "Ototoxicity note" },
  {
    prefix: "uv-exposure:",
    domain: "Warnings",
    label: () => "UV overexposure note",
  },
  {
    prefix: WEATHER_MED_PREFIX,
    domain: "Warnings",
    label: () => "Weather-safety note",
  },
  {
    prefix: FOOD_TIMING_PREFIX,
    domain: "Warnings",
    label: () => "Food-timing guidance",
  },
  {
    prefix: KEEP_APART_PREFIX,
    domain: "Warnings",
    label: () => "Keep-apart timing note",
  },
  // ---- Coaching extras (non-registry namespaces on the bus) ----------------
  {
    prefix: "coaching:",
    domain: "Coaching",
    label: (t) => {
      const n = titleize(t.replace(/[_-]/g, " "));
      return n ? `Coaching — ${n}` : "Coaching recommendation";
    },
  },
  {
    prefix: "digest:",
    domain: "Coaching",
    label: () => "Trending digest chip",
  },
  {
    // Personal-record celebrations (#1931). Keyed `pr:strength:<movement>@<lane>:<kind>`
    // and `pr:cardio:<activity>:<kind>` — the tail is a canonical IDENTITY, already
    // lowercased, so titleize is the honest rendering of a name whose casing is gone.
    prefix: PR_STRENGTH_PREFIX,
    domain: "Coaching",
    label: (t) => {
      const n = titleize(part(t, 0).split("@")[0]);
      return n ? `Personal record — ${n}` : "Personal record";
    },
  },
  {
    prefix: PR_CARDIO_PREFIX,
    domain: "Coaching",
    label: (t) => {
      const n = titleize(part(t, 0));
      return n ? `Personal record — ${n}` : "Personal record";
    },
  },
  // ---- Suggestions (suggest-only per-surface rows) -------------------------
  {
    prefix: MED_BRIDGE_PREFIX,
    domain: "Suggestions",
    label: (t) => {
      const n = titleize(t);
      return n ? `Untracked prescription — ${n}` : "Untracked prescription";
    },
  },
  {
    prefix: DORMANT_PRN_PREFIX,
    domain: "Suggestions",
    label: () => "Dormant PRN suggestion",
  },
  {
    prefix: CONDITION_CONSIDERATION_PREFIX,
    domain: "Suggestions",
    label: () => "Condition consideration",
  },
  {
    // Pre-surgery / Post-op suggestion from a scheduled surgical visit (#1299) —
    // suggest-only, dismissed per-procedure. `surgery-bridge:<phase>:<visitId>`.
    prefix: SURGERY_BRIDGE_PREFIX,
    domain: "Suggestions",
    label: (t) =>
      part(t, 0) === "post" ? "Post-op suggestion" : "Pre-surgery suggestion",
  },
  {
    // The continuous-stream ONBOARDING offer (#2162): "your watch started sending
    // heart rate — want the bedtime reminder?" answered with No thanks. Not in
    // RULE_FINDING_REGISTRY for the same reason `pool-refill:` isn't — no rule builder
    // emits it, and the registry's reflection guards read builder output. Both tails
    // are registry vocabulary, so the provider reads back as a name.
    prefix: STREAM_ONBOARD_PREFIX,
    domain: "Suggestions",
    label: (t) => {
      const provider = titleize(part(t, 0).replace(/[_-]/g, " "));
      return provider
        ? `Bedtime watch reminder offer — ${provider}`
        : "Bedtime watch reminder offer";
    },
  },
  {
    // The OFFBOARDING prompt (#2162), answered either way — "Turn them off" and
    // "Keep them ready" both dismiss THIS lapse episode, and the tail's episode day is
    // what keeps a later lapse from arriving pre-silenced.
    prefix: STREAM_OFFBOARD_PREFIX,
    domain: "Suggestions",
    label: (t) => {
      const provider = titleize(part(t, 0).replace(/[_-]/g, " "));
      return provider
        ? `Paused watch reminder note — ${provider}`
        : "Paused watch reminder note";
    },
  },
];

// The full ordered resolver table: registry namespaces first (their prefixes are
// the most specific / most numerous), then the extra namespaces. Order matters
// only where prefixes could nest; none of these overlap (pinned by the registry
// invariants + the coverage guard).
const RESOLVER_TABLE: ResolverEntry[] = [
  ...RULE_FINDING_REGISTRY.map((e): ResolverEntry => ({
    prefix: e.prefix,
    domain: registryDomain(e),
    label:
      REGISTRY_LABELS[e.prefix] ??
      // A registry prefix with no explicit template still resolves (the
      // builder name, humanized) — the coverage guard asserts the explicit
      // template exists, so this fallback is belt-and-suspenders only.
      (() => "Coaching finding"),
  })),
  ...EXTRA_ENTRIES,
];

// Every namespace the resolver knows (for the coverage guard + docs).
export const SUPPRESSION_DISPLAY_PREFIXES: readonly string[] =
  RESOLVER_TABLE.map((e) => e.prefix);

// Whether the registry namespace has an EXPLICIT label template (the coverage
// guard asserts this for every registry entry, so a new finding engine must add
// its label when it adds its prefix).
export function hasExplicitRegistryLabel(prefix: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY_LABELS, prefix);
}

// Resolve a suppressed dedupeKey to its display, or null when the key belongs to
// no known namespace (the caller renders the orphan row).
export function resolveSuppressedKeyDisplay(
  key: string
): SuppressedKeyDisplay | null {
  const entry = RESOLVER_TABLE.find((e) => key.startsWith(e.prefix));
  if (!entry) return null;
  const tail = key.slice(entry.prefix.length);
  const label = entry.label(tail).trim();
  return { domain: entry.domain, label: label || ORPHAN_SUPPRESSION_LABEL };
}

// The domain group for a RICH care-tier row (a reconstructed UpcomingItem) so the
// grouped section can slot it alongside the resolver-labelled rows. Falls back to
// the resolver's own namespace mapping, else "Due & scheduled" (every rich row
// comes from the Upcoming/attention gather, which is the care tier).
export function domainForRichKey(key: string): SuppressionDomain {
  return resolveSuppressedKeyDisplay(key)?.domain ?? "Due & scheduled";
}

// Render order for the grouped section.
export const SUPPRESSION_DOMAIN_ORDER: readonly SuppressionDomain[] = [
  "Due & scheduled",
  "Biomarkers",
  "Warnings",
  "Care",
  "Coaching",
  "Suggestions",
  "Other",
];
