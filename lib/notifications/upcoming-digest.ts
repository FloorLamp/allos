// The "what's due" Today-section formatter — PURE assembly, no DB/network, so it's
// unit-tested in lib/__tests__. Since issue #1108 there is no second "what's due"
// message: the morning digest (./digest) EMBEDS this banded summary as its Today
// section, so snooze/dismiss (the findings bus, applied by collectUpcoming) and the
// #221 one-computation rule govern the whole morning message. buildUpcomingDigest
// turns the ALREADY-BANDED collectUpcoming set (groupUpcoming) into a compact
// count-by-domain summary + the high-priority "why" highlights (#656), returning
// null when nothing is due. It takes an optional `excludeDomains` (the digest drops
// `dose`, summarized separately by the dose-count headline).

import type { BandGroup, UpcomingDomain, UpcomingItem } from "../upcoming";
import { primaryReason } from "../reasons";

// Singular noun per domain; the summary pluralizes with a trailing "s". "lab"
// reads naturally as the retest signal ("1 lab, 2 labs"); "training target" and
// "vaccine" mirror the page's language.
const DOMAIN_NOUN: Record<UpcomingDomain, string> = {
  dose: "dose",
  "prn-max": "over-max PRN",
  refill: "refill",
  "dietary-limit": "intake limit",
  "illness-care": "illness check",
  // A condition-review suggestion (#685). Care-tier on the hero/Upcoming, but
  // deliberately NOT pushed — omitted from DOMAIN_SEQ (like the "something's off"
  // signals), so it's never counted in this digest even though the noun exists.
  "condition-review": "condition to review",
  // A recorded drug allergy met by an active med (#1029). Care-tier, counted in the
  // push alongside the interaction notes it mirrors.
  "allergy-med": "allergy note",
  interaction: "interaction",
  pgx: "pharmacogenomic note",
  contrast: "contrast-safety note",
  "dental-safety": "dental-safety note",
  ototoxic: "hearing-safety note",
  // A same-day UV overexposure heads-up (#1172). Care-tier, counted in the push
  // alongside the other same-day med/sun-safety notes.
  "uv-exposure": "UV overexposure note",
  appointment: "appointment",
  visit: "preventive visit",
  screening: "screening",
  immunization: "vaccine",
  biomarker: "lab",
  // A med-driven monitoring retest (#995). Care-tier entries push via the #656 highlight
  // (their cited reason), NOT via this per-band count — `med-monitor` is deliberately
  // omitted from DOMAIN_SEQ, so a coaching-tier monitoring lab is never counted in the
  // push. The noun exists only because the Record is exhaustive.
  "med-monitor": "monitoring lab",
  goal: "goal",
  training: "training target",
  // A wellness-practice weekly target (#1259). Coaching-tier (calm) — its OWN pace-aware
  // nudge is the push channel, so it's deliberately omitted from DOMAIN_SEQ and never
  // counted in this digest; the exhaustive Record needs the noun.
  practice: "practice target",
  careplan: "care-plan item",
  // A finding follow-up (#700). Care-tier on the hero/Upcoming (an overdue one
  // escalates there + resists dismiss), but the Telegram digest push is deliberately
  // scoped OUT for v1 (like condition-review) — omitted from DOMAIN_SEQ, so it's
  // never counted here even though the noun exists. A push is a follow-up decision.
  followup: "finding follow-up",
  // A mental-health crisis finding (#716). Care-tier on the hero/Upcoming, but
  // DELIBERATELY never pushed on any channel — omitted from DOMAIN_SEQ, so it's never
  // counted in this digest even though the exhaustive Record needs the noun. The
  // decided harm case is crisis content landing on a shared/locked device.
  "mental-health": "mental-health check-in",
  // The unified model's "something's off" signals (issue #524) never reach this
  // digest — it groups collectUpcoming, which is date-scheduled due-signals only —
  // but the exhaustive Record needs an entry. DOMAIN_SEQ omits them, so they're
  // never counted even if one ever appeared.
  "biomarker-flag": "flagged result",
  integration: "sync issue",
  review: "review item",
};

// Fixed within-band ordering for the count phrase, matching the page's domain
// order so the digest reads in the same sequence the user sees.
const DOMAIN_SEQ: UpcomingDomain[] = [
  "dose",
  "prn-max",
  "refill",
  "dietary-limit",
  "illness-care",
  "allergy-med",
  "interaction",
  "pgx",
  "contrast",
  "dental-safety",
  "ototoxic",
  "uv-exposure",
  "appointment",
  "careplan",
  "visit",
  "screening",
  "immunization",
  "biomarker",
  "goal",
  "training",
];

// A surfaced "why" for a high-priority item (issue #656 item 3): the item's title
// plus its TOP reason text, so the push says WHY the important thing matters instead
// of only counting it. The reason is the SAME primaryReason() the page/hero carry on
// the item — one computation, proven by the shared-fixture pin.
export interface DigestHighlight {
  title: string;
  reason: string;
}

export interface UpcomingDigestModel {
  title: string;
  // One compact line per non-empty band, e.g. "Today: 2 doses, 1 appointment".
  lines: string[];
  // Up to MAX_HIGHLIGHTS "why" lines for the most important items carrying a
  // structured reason (issue #656). Empty when nothing due carries a reason — the
  // digest then reads exactly as before (counts only).
  highlights: DigestHighlight[];
  // Total items across all bands (drives the title count).
  total: number;
}

// Keep the push compact: at most a few "why" lines beyond the per-band counts.
const MAX_HIGHLIGHTS = 3;

// The high-priority items' top reasons (issue #656 item 3). Scans the banded set in
// urgency order (Overdue → Today → …, each already within-band sorted so the higher-
// priority item leads), keeps items that carry a structured reason, prefers higher
// `priority`, de-dupes by title, and caps the list. The reason shown is
// primaryReason(item) — the SAME lead reason the page/hero render, never re-derived.
export function digestHighlights(groups: BandGroup[]): DigestHighlight[] {
  const candidates: { item: UpcomingItem; order: number }[] = [];
  let order = 0;
  for (const g of groups) {
    for (const item of g.items) {
      if (primaryReason(item.reasons))
        candidates.push({ item, order: order++ });
    }
  }
  // Stable sort: higher priority first, then the natural urgency order above.
  candidates.sort(
    (a, b) =>
      (b.item.priority ?? 0) - (a.item.priority ?? 0) || a.order - b.order
  );
  const out: DigestHighlight[] = [];
  const seen = new Set<string>();
  for (const { item } of candidates) {
    if (out.length >= MAX_HIGHLIGHTS) break;
    if (seen.has(item.title)) continue;
    seen.add(item.title);
    out.push({ title: item.title, reason: primaryReason(item.reasons)!.text });
  }
  return out;
}

function pluralize(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// "2 doses, 1 appointment" for a band: count items by domain, then render in the
// fixed domain sequence so the phrase is deterministic. `exclude` drops whole
// domains from the count (issue #1108 — the morning digest excludes `dose`, which
// its dose-count headline already summarizes); an empty result string means every
// counted item was excluded, so the caller can drop the band's line entirely.
export function summarizeBand(
  group: BandGroup,
  exclude?: ReadonlySet<UpcomingDomain>
): string {
  const counts = new Map<UpcomingDomain, number>();
  for (const item of group.items) {
    if (exclude?.has(item.domain)) continue;
    counts.set(item.domain, (counts.get(item.domain) ?? 0) + 1);
  }
  return DOMAIN_SEQ.filter((d) => counts.has(d))
    .map((d) => pluralize(DOMAIN_NOUN[d], counts.get(d)!))
    .join(", ");
}

// Build the Today-section model from the ALREADY-BANDED set (groupUpcoming output),
// or null when there's nothing to summarize (so the digest's Today section stays
// empty rather than rendering a hollow "all clear"). Empty bands are already dropped
// by groupUpcoming; a band whose only items are in `excludeDomains` yields an empty
// summary and its line is dropped here too, so excluding every due domain returns
// null. `total` counts every banded item (regardless of exclusion) — the exclusion
// only affects the rendered per-band lines.
export function buildUpcomingDigest(
  profileName: string,
  groups: BandGroup[],
  opts: { excludeDomains?: readonly UpcomingDomain[] } = {}
): UpcomingDigestModel | null {
  const exclude = opts.excludeDomains?.length
    ? new Set<UpcomingDomain>(opts.excludeDomains)
    : undefined;
  const nonEmpty = groups.filter((g) => g.items.length > 0);
  const lines = nonEmpty
    .map((g) => ({ label: g.label, summary: summarizeBand(g, exclude) }))
    .filter((b) => b.summary.length > 0)
    .map((b) => `${b.label}: ${b.summary}`);
  if (lines.length === 0) return null;
  const total = nonEmpty.reduce((n, g) => n + g.items.length, 0);
  const who = profileName ? ` — ${profileName}` : "";
  return {
    title: `🔔 Due soon${who}`,
    lines,
    highlights: digestHighlights(nonEmpty),
    total,
  };
}
