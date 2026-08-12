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
import { formatMessageLine } from "./message-line";
import { GLYPH } from "./glyphs";

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
  // A food-log × food–drug co-occurrence (#2021). Care-tier on the hero/Upcoming and
  // deliberately NOT pushed — omitted from DOMAIN_SEQ, so it is never counted in this
  // digest. Nobody declared "tell me when I drink" (the contact-consent rule), and a
  // message that arrives because you logged a beer would be surveillance-shaped. The
  // noun exists only because the Record is exhaustive.
  "food-drug-event": "food note",
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
  // The nutrition and mobility weekly-floor targets (#2578). Same tier and the same
  // digest reach as `training` — they were already counted inside this digest's
  // training line before the identity split, so they stay in DOMAIN_SEQ under their
  // own nouns rather than quietly leaving the message. No new send, no new schedule:
  // the same line, one honest noun each.
  "nutrition-target": "nutrition target",
  "mobility-target": "mobility target",
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
  // A broken sync (#1685) and an open portal sync request (#1757). Both are NAMED-LINE
  // domains (see NAMED_LINE_DOMAINS below), and since #1913 item 5 a named line IS the
  // band item rather than a sibling of a count — so neither noun is ever rendered. They
  // stay because the Record is exhaustive, exactly like the never-counted domains above.
  //
  // `portal check` in particular was a bug waiting in the noun (#1913 item 8): every
  // other noun here names something OWED ("1 refill", "1 appointment"), while "check" is
  // equally a completed event, so "This week: 1 portal check, 4 of 4 training targets on
  // pace" parsed as something the household had already done. The merge retires the
  // phrase rather than rewording it.
  integration: "sync issue",
  "portal-sync": "portal check",
  // A records-recency ask (#2164/#2176) is a NAMED-LINE domain too, so this noun is
  // never rendered either — same as the two above, and here for the same exhaustive-
  // Record reason.
  "records-recency": "records refresh",
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
  "records-recency",
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
  "nutrition-target",
  "mobility-target",
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
  // The bullet character, resolved from the DOMAIN (#1913 item 8) rather than branched
  // on in the renderer — see NAMED_LINE_DOMAINS.
  glyph: string;
  // A SHORT CAUSE FRAGMENT, written deliberately by the producer for this surface
  // (#1913 item 6 — owner ruling).
  //
  // The old field was the item's `detail`, and `${title} — ${detail}` silently assumed
  // that detail was a cause fragment. That held for the integration producer ("Weather &
  // UV sync needs attention — weather fetch failed (503)") and was never stated, so the
  // portal producer wrote to a different contract: `syncRequestCopy`'s detail is a
  // COMPLETE SENTENCE that re-contains the title ("tbh has never been checked — run the
  // portal tool on your computer."), and joined it read imperative → em dash → subject
  // restated → em dash → the same imperative.
  //
  // Putting the contract in the TYPE is the point: the next producer of a named line is
  // asked for a cause fragment by the signature instead of inheriting a convention it
  // could only learn by reading this renderer. It is a field, not a second set of words —
  // `syncRequestCopy` remains the one formatter for the ask itself.
  because: string | null;
  // The DEADLINE the ask carries, when it has one (#1913 item 7): a sync request expires,
  // and that expiry is the only deadline it has. Null for a broken integration, which has
  // none — its `dueText` is a CTA label ("Reconnect"), never a date. Which domains carry
  // one is declared in NAMED_LINE_DOMAINS, not decided here.
  dueText: string | null;
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

// What a NAMED-LINE domain has to declare. Both members are data-plumbing facts whose
// whole point is that they happen without you opening the app, so a count alone would
// send the reader back to the surface the signal exists to save them from.
interface NamedLineDomain {
  // The bullet character (#1913 item 8, owner ruling). Two different asks used to share
  // 🔌: "a connection broke and allos will keep retrying" versus "get up, go to a
  // particular computer, and do it yourself" — the one line in the whole digest that
  // cannot be acted on from the phone it is being read on, rendered identically to a
  // dead API token. The glyph now says WHO ACTS, and it lives here rather than as a
  // branch in the renderer, so a new named-line domain has to choose one instead of
  // defaulting into 🔌 silently.
  glyph: string;
  // Whether this domain's item carries a real DEADLINE in `dueText` (#1913 item 7).
  // A broken integration does not — waiting never fixes it and nothing expires — and its
  // `dueText` is a CTA label, so printing it as a deadline would invent one.
  carriesDeadline: boolean;
  // Why those two answers. Required, in the house's registry style: "we decided" and
  // "nobody looked" have to stay distinguishable.
  why: string;
}

const NAMED_LINE_DOMAINS: Partial<Record<UpcomingDomain, NamedLineDomain>> = {
  integration: {
    glyph: GLYPH.allosRetries,
    carriesDeadline: false,
    why: "A connection is broken and allos will keep retrying (#1685). Nobody has to go anywhere, and there is no date by which it stops mattering — the item's `dueText` is the CTA ('Reconnect' / 'No recent data'), which is not a deadline.",
  },
  "portal-sync": {
    glyph: GLYPH.personActs,
    carriesDeadline: true,
    why: `An errand only a PERSON can run, away from the device reading the message (#1757). ${GLYPH.personActs} is deliberately domain-neutral rather than ${GLYPH.device}: the distinction is who acts, not what hardware is involved, so a future errand line in another domain inherits it. The request EXPIRES, and that expiry is the only deadline the ask has.`,
  },
  "records-recency": {
    glyph: GLYPH.personActs,
    carriesDeadline: false,
    why: "The domain-neutral errand glyph, inherited exactly as the portal line's comment anticipated (#2164/#2176): downloading a Takeout archive or photographing a paper result is an errand only a person can run. It carries NO deadline — unlike a portal request, nothing here expires, and the item's `dueText` states the drift ('6 weeks behind'), so printing it as a deadline would invent one.",
  },
};

function namedLine(domain: UpcomingDomain): NamedLineDomain | undefined {
  return NAMED_LINE_DOMAINS[domain];
}

// The banded set's named data-plumbing items, in band order (#1685/#1757). Reads the
// items straight off the model — title, cause and href as the shared builder already
// decided them — so the digest can never word a broken sync, or a portal request,
// differently from the page.
export function digestSyncIssues(groups: BandGroup[]): DigestSyncIssue[] {
  const out: DigestSyncIssue[] = [];
  for (const g of groups) {
    for (const item of g.items) {
      const named = namedLine(item.domain);
      if (!named) continue;
      out.push({
        title: item.title,
        glyph: named.glyph,
        // The producer's own fragment, never the page's `detail` (#1913 item 6). A
        // producer that writes none renders a bare title rather than borrowing a
        // sentence that was written for a card.
        because: item.because ?? null,
        dueText: named.carriesDeadline ? (item.dueText ?? null) : null,
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
  // ONE ENTRY PER NAMED-LINE ITEM (#1913 items 2 and 5). A named-line domain used to be
  // counted in its band AND named below it, so a single 503 arrived twice in one message
  // — "📝 Today: Weather & UV sync needs attention" over "🔌 Weather & UV sync needs
  // attention — weather fetch failed (503)" — which is the #1880 one-surface disease
  // inside the digest.
  //
  // The merge is keyed on NAMED_LINE_DOMAINS rather than on the weather standing,
  // deliberately: it is a property of the digest's SHAPE, not of one domain. A merge
  // keyed to the weather case would have left the portal double-mentioning after that
  // issue closed. The named line is the band item; nothing else changes, and `total`
  // still counts every banded item.
  const exclude = new Set<UpcomingDomain>([
    ...(opts.excludeDomains ?? []),
    ...(Object.keys(NAMED_LINE_DOMAINS) as UpcomingDomain[]),
  ]);
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
  return {
    // The profile name is a NOTE on the title — a shared chat can carry several.
    title: formatMessageLine({
      glyph: GLYPH.reminding,
      head: "Due soon",
      notes: [profileName],
    }),
    lines,
    highlights: digestHighlights(nonEmpty),
    syncIssues,
    total,
  };
}
