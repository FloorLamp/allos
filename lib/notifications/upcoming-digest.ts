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
import type { AppRoute } from "../hrefs";

// Singular noun per domain; the summary pluralizes with a trailing "s". "lab"
// reads naturally as the retest signal ("1 lab, 2 labs"); "training target" and
// "vaccine" mirror the page's language.
const DOMAIN_NOUN: Record<UpcomingDomain, string> = {
  dose: "dose",
  // A `may` item on offer (#1505). NEVER pushed — omitted from DOMAIN_SEQ, so it is
  // never counted in this digest; its access path is the digest's own "Log other…"
  // tail, which is user-initiated. The noun exists only because the Record is
  // exhaustive.
  available: "available item",
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
  // A med × conditions note (#1727). Care-tier, counted alongside the other med-safety
  // notes — it rides the digest that already fires and adds no send of its own.
  "weather-med": "weather-safety note",
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
  // A broken sync (#1685). The ONLY signal-group domain that IS in DOMAIN_SEQ, so it is
  // the only one this digest counts. See the sequence below for why it earns that.
  integration: "sync issue",
  // An open portal sync request (#1757). In DOMAIN_SEQ, and named below, for the same
  // reason a broken sync is: a portal run needs a person at a machine, so a nudge that
  // reaches only the surfaces you have to open to see is a nudge to someone who is
  // already looking. It rides the digest that already sends and adds no send of its own.
  "portal-sync": "portal check",
  review: "review item",
};

// Fixed within-band ordering for the count phrase, matching the page's domain
// order so the digest reads in the same sequence the user sees.
//
// `integration` joins the sequence in #1685 — the one deliberate addition from outside
// the date-scheduled set. The reasoning, recorded because every other omission above is
// also deliberate: an integration exists so data flows WITHOUT opening the app, which
// makes a dead one exactly the state its owner is least likely to notice, and a revoked
// grant is unrecoverable without their re-consent, so waiting never fixes it. Reaching
// only the surfaces you have to open to see inverts the feature's purpose. It rides the
// digest that already sends — no dedicated notification, no escalation, no new schedule
// (the ride-the-nag corollary of the attention doctrine).
const DOMAIN_SEQ: UpcomingDomain[] = [
  "dose",
  "integration",
  "portal-sync",
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
  "weather-med",
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

// One NAMED data-plumbing line for the digest (#1685, extended by #1757), lifted from the
// SAME UpcomingItem the hero and the Upcoming page render — never a second description of
// the same fact. A bare per-band count ("1 sync issue", "1 portal check") cannot be acted
// on: you need to know WHICH source stopped, or WHICH portal wants a run, and where to go.
// So the count line stays the glance, and this names the subject and carries its href —
// the same relationship the #656 "why" highlights have with the counts they sit under.
export interface DigestSyncIssue {
  title: string;
  detail: string | null;
  // The item's own href, relative (e.g. "/integrations/withings"). The renderer makes it
  // absolute when a public app URL is configured and drops it otherwise.
  href: AppRoute;
}

export interface UpcomingDigestModel {
  title: string;
  // One compact line per non-empty band, e.g. "Today: 2 doses, 1 appointment".
  lines: string[];
  // Up to MAX_HIGHLIGHTS "why" lines for the most important items carrying a
  // structured reason (issue #656). Empty when nothing due carries a reason — the
  // digest then reads exactly as before (counts only).
  highlights: DigestHighlight[];
  // The broken-sync lines (#1685), in banded order. Empty for a healthy profile, which
  // is what keeps a working setup's digest byte-identical to before.
  syncIssues: DigestSyncIssue[];
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

// The domains that get a NAMED line rather than only a count. Both are data-plumbing
// facts whose whole point is that they happen without you opening the app, so a count
// alone would send the reader back to the surface the signal exists to save them from.
const NAMED_LINE_DOMAINS: readonly UpcomingDomain[] = [
  "integration",
  "portal-sync",
];

// The banded set's named data-plumbing items, in band order (#1685/#1757). Reads the
// items straight off the model — title, detail and href as the shared builder already
// decided them — so the digest can never word a broken sync, or a portal request,
// differently from the page.
export function digestSyncIssues(groups: BandGroup[]): DigestSyncIssue[] {
  const out: DigestSyncIssue[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      if (!NAMED_LINE_DOMAINS.includes(item.domain)) continue;
      out.push({
        title: item.title,
        detail: item.detail ?? null,
        href: item.href,
      });
    }
  }
  return out;
}

function pluralize(noun: string, count: number): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// How the band phrase may be reshaped per caller (#1819 items 4 and 5).
export interface BandSummaryOptions {
  // NAME the items instead of counting them when the band holds at most this many
  // (#1819 item 5): "Overdue: colonoscopy · CBC, lipid panel". A count is the right
  // shape only once naming would stop fitting on a line — below that it withholds
  // the one thing the reader needs. 0/absent ⇒ always count, the old behavior.
  nameAtMost?: number;
  // A phrase that REPLACES a domain's count (#1819 item 4): the digest supplies the
  // weekly-progress line for `training`, so "4 training targets" becomes "2 of 4
  // training targets on pace". Called with the band's items of that domain so the
  // caller can decline when they are not all what its phrase describes — several
  // findings share the `training` domain, and a phrase about weekly targets must not
  // silently stand in for an endurance event.
  phraseFor?: (
    domain: UpcomingDomain,
    items: readonly UpcomingItem[]
  ) => string | null;
}

// "2 doses, 1 appointment" for a band: count items by domain, then render in the
// fixed domain sequence so the phrase is deterministic. `exclude` drops whole
// domains from the count (issue #1108 — the morning digest excludes `dose`, which
// its dose-count headline already summarizes); an empty result string means every
// counted item was excluded, so the caller can drop the band's line entirely.
//
// With `nameAtMost` a SMALL band names its items instead ("colonoscopy · CBC, lipid
// panel"): peers within one domain join with ", " and the domains themselves with
// " · ", matching the digest's separator grammar. Naming is skipped for any domain
// carrying a `phrase` override — that phrase already says more than a list of names.
export function summarizeBand(
  group: BandGroup,
  exclude?: ReadonlySet<UpcomingDomain>,
  opts: BandSummaryOptions = {}
): string {
  const byDomain = new Map<UpcomingDomain, UpcomingItem[]>();
  for (const item of group.items) {
    if (exclude?.has(item.domain)) continue;
    const kept = byDomain.get(item.domain) ?? [];
    kept.push(item);
    byDomain.set(item.domain, kept);
  }
  const present = DOMAIN_SEQ.filter((d) => byDomain.has(d));
  const shown = present.reduce((n, d) => n + byDomain.get(d)!.length, 0);
  const nameable = shown > 0 && shown <= (opts.nameAtMost ?? 0);
  const parts = present.map((d) => {
    const items = byDomain.get(d)!;
    const override = opts.phraseFor?.(d, items);
    if (override) return override;
    if (nameable) return items.map((i) => i.title).join(", ");
    return pluralize(DOMAIN_NOUN[d], items.length);
  });
  return parts.join(nameable ? " · " : ", ");
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
  opts: {
    excludeDomains?: readonly UpcomingDomain[];
  } & BandSummaryOptions = {}
): UpcomingDigestModel | null {
  const exclude = opts.excludeDomains?.length
    ? new Set<UpcomingDomain>(opts.excludeDomains)
    : undefined;
  const nonEmpty = groups.filter((g) => g.items.length > 0);
  const lines = nonEmpty
    .map((g) => ({
      label: g.label,
      summary: summarizeBand(g, exclude, {
        nameAtMost: opts.nameAtMost,
        phraseFor: opts.phraseFor,
      }),
    }))
    .filter((b) => b.summary.length > 0)
    .map((b) => `${b.label}: ${b.summary}`);
  const syncIssues = digestSyncIssues(nonEmpty);
  // A day whose ONLY banded content is a broken sync still has something to say (#1685):
  // returning null here would drop the named line along with the count and leave the dead
  // integration reaching nothing again, which is the whole bug.
  if (lines.length === 0 && syncIssues.length === 0) return null;
  const total = nonEmpty.reduce((n, g) => n + g.items.length, 0);
  const who = profileName ? ` — ${profileName}` : "";
  return {
    title: `🔔 Due soon${who}`,
    lines,
    highlights: digestHighlights(nonEmpty),
    syncIssues,
    total,
  };
}
