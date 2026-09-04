// Pure ranking/merging for the global (Cmd-K) search. The DB
// fan-out in lib/queries/search.ts decides *what* matches (profile-scoped LIKE
// queries per domain); this module decides *ordering*: it scores each hit's
// match quality (exact > prefix > substring), breaks ties by recency, and groups
// the flat hit list into the fixed domain order the palette renders. Kept free of
// DB/React so it can be unit-tested (lib/__tests__/search-rank.test.ts).

import type { AppRoute } from "./hrefs";
import type { HistoryKind } from "./history-format";

// THE RECORD'S OWN ROWS, AS SEARCH DOMAINS (#5006). Seven of the record's Logs kinds
// are row-only — no page of their own — so a hit lands on the day view scrolled to the
// row it names (lib/queries/search-logged.ts builds them). The domain IS the record
// kind, prefixed so the entity domain beside it keeps its name: `practice` is the
// wellness practice you track, `log-practice` is a session of it.
//
// `satisfies readonly HistoryKind[]` is the whole guard: a kind that is not one of the
// record's own is a type error here rather than a hit whose `?kind=` opens on nothing.
export const SEARCH_LOGGED_KINDS = [
  "dose",
  "food",
  "practice",
  "symptom",
  "mood",
  "body",
  "sleep",
] as const satisfies readonly HistoryKind[];

export type SearchLoggedKind = (typeof SEARCH_LOGGED_KINDS)[number];
export type LoggedSearchDomain = `log-${SearchLoggedKind}`;

export function loggedSearchDomain(
  kind: SearchLoggedKind
): LoggedSearchDomain {
  return `log-${kind}`;
}

const LOGGED_DOMAINS: ReadonlySet<string> = new Set(
  SEARCH_LOGGED_KINDS.map(loggedSearchDomain)
);

export function isLoggedSearchDomain(
  domain: SearchDomain
): domain is LoggedSearchDomain {
  return LOGGED_DOMAINS.has(domain);
}

export type SearchDomain =
  | LoggedSearchDomain
  | "clinical-result"
  | "imaging"
  | "genomic"
  | "document"
  | "condition"
  | "allergy"
  | "procedure"
  | "immunization"
  | "encounter"
  | "appointment"
  | "provider"
  | "episode"
  | "dental"
  | "skin"
  | "activity"
  | "supplement"
  | "protocol"
  | "practice"
  | "equipment"
  | "family-history"
  | "care-plan"
  | "care-goal"
  | "goal"
  | "page";

// A per-hit contextual action (#662): act on a FOUND entity without first
// navigating to its page — log a dose of this medication, refill it, complete
// this appointment, add a clinical result. A WRITE action (`log-dose`
// /`refill`/`complete`) carries `entityId`, the row id the palette submits as
// FormData `id` to the EXISTING gated Server Action (never a search-side bypass —
// the auth gate stays in the action). A NAVIGATE action (`add-result`) carries an
// `href` instead (the clinical-result add form, name-prefilled). The applicable actions
// per kind are built by the pure `lib/hit-actions.ts` matchers so the labels/gates
// stay unit-tested and out of the DB fan-out.
export type HitActionKind = "log-dose" | "refill" | "complete" | "add-result";

export interface HitAction {
  kind: HitActionKind;
  label: string;
  // The row id a write action targets (submitted as FormData `id`). 0 for a
  // navigate-only action (add-result), which uses `href`.
  entityId: number;
  // Present only for navigate-style actions (add-result); the write kinds omit it.
  href?: AppRoute;
}

export interface SearchHit {
  domain: SearchDomain;
  // Stable, domain-unique key — React key and dedup identity.
  key: string;
  // Primary text the hit is matched/ranked against and shown as the result's
  // main line.
  title: string;
  // Secondary line (value/date/type/status); not used for ranking.
  subtitle: string | null;
  href: AppRoute;
  // ISO date (YYYY-MM-DD) for the recency tiebreak; null for undated hits
  // (supplements, goals, pages), which sort after dated ones at the same tier.
  date: string | null;
  // Per-hit contextual actions (#662), when the hit's kind offers any. Absent for
  // navigation-only hits.
  actions?: HitAction[];
}

export interface SearchGroup {
  domain: SearchDomain;
  label: string;
  hits: SearchHit[];
}

// The order result groups appear in the palette (mirrors the issue's list).
// The clinical passport domains (#19) are grouped with the medical domains they
// live beside in the nav, keeping clinical results first and goal/page last.
//
// The second-generation ENTITY domains (#1595) slot in beside the surface each one
// shares: imaging/genomics join clinical results under Results; providers close the
// history/visit run they were previously only a label on; illness episodes, dental,
// and skin follow as the remaining record surfaces; protocols, practices, and
// equipment sit with the training/lifestyle rows. The RELATIVE order of the original
// domains is unchanged, so an existing reader's muscle memory survives.
export const SEARCH_DOMAIN_ORDER: SearchDomain[] = [
  "clinical-result",
  "imaging",
  "genomic",
  "document",
  "condition",
  "allergy",
  "procedure",
  "immunization",
  "encounter",
  "appointment",
  "provider",
  "episode",
  "dental",
  "skin",
  "activity",
  // THE LOGGED ROWS (#5006) sit with the activity they read like — things that
  // happened, newest first — and above the catalog entities (`supplement`,
  // `practice`, `equipment`) that name what they were logged against. Every one of
  // them is ahead of `page`, which is what puts an entry above the kind's own
  // static list entry ("Food history") for a query matching both.
  "log-dose",
  "log-food",
  "log-practice",
  "log-symptom",
  "log-mood",
  "log-body",
  "log-sleep",
  "supplement",
  "protocol",
  "practice",
  "equipment",
  "family-history",
  "care-plan",
  "care-goal",
  "goal",
  "page",
];

export const SEARCH_DOMAIN_LABELS: Record<SearchDomain, string> = {
  "clinical-result": "Clinical results",
  imaging: "Imaging",
  genomic: "Genomics",
  document: "Documents",
  condition: "Conditions",
  allergy: "Allergies",
  procedure: "Procedures",
  immunization: "Immunizations",
  encounter: "Visits",
  appointment: "Appointments",
  provider: "Providers",
  episode: "Illness Episodes",
  dental: "Dental",
  skin: "Skin",
  activity: "Activities",
  // The record's own words for these rows (#5006), and not the record's CHIP labels:
  // a chip names a filter ("Practices"), a palette group names what the rows are, and
  // "Practices" is already the wellness-practice group one row down.
  "log-dose": "Doses",
  "log-food": "Food servings",
  "log-practice": "Practice sessions",
  "log-symptom": "Symptoms",
  "log-mood": "Check-ins",
  "log-body": "Body readings",
  "log-sleep": "Sleep nights",
  supplement: "Supplements",
  protocol: "Protocols",
  practice: "Practices",
  equipment: "Equipment",
  "family-history": "Family History",
  "care-plan": "Care Plan",
  "care-goal": "Care Goals",
  goal: "Goals",
  page: "Pages",
};

// How closely `query` matches `text`: 3 exact, 2 prefix, 1 substring, 0 none.
// Case- and edge-whitespace-insensitive.
export function matchTier(text: string, query: string): number {
  const t = text.trim().toLowerCase();
  const q = query.trim().toLowerCase();
  if (q === "" || t === "") return 0;
  if (t === q) return 3;
  if (t.startsWith(q)) return 2;
  if (t.includes(q)) return 1;
  return 0;
}

// Order hits within one domain: match quality desc, then recency (later date
// first, undated last), then title/key for a stable, deterministic order.
//
// THE LOGGED DOMAINS INVERT THE FIRST TWO KEYS (#5006), and only they do. An entity
// is asked for by NAME, so the best-named match wins; a logged row is asked for by
// RECENCY — "my latest sauna" — and the words are how you narrow to the kind, not how
// you choose between two rows of it. Tier-first put a year-old "Sauna" above this
// morning's "Sauna, infrared" for exactly the query the feature exists to answer.
export function sortHits(hits: SearchHit[], query: string): SearchHit[] {
  return [...hits].sort((a, b) => {
    const ta = matchTier(a.title, query);
    const tb = matchTier(b.title, query);
    // Recency: compare ISO date strings lexically; "" (undated) sorts last.
    const da = a.date ?? "";
    const db = b.date ?? "";
    const dateFirst =
      isLoggedSearchDomain(a.domain) && isLoggedSearchDomain(b.domain);
    if (dateFirst && da !== db) return da < db ? 1 : -1;
    if (ta !== tb) return tb - ta;
    if (da !== db) return da < db ? 1 : -1;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });
}

// Merge a flat hit list into grouped, ranked results: each domain sorted and
// capped, emitted in SEARCH_DOMAIN_ORDER, dropping empty groups.
export function rankAndGroup(
  hits: SearchHit[],
  query: string,
  perDomainCap = 5
): SearchGroup[] {
  const groups: SearchGroup[] = [];
  for (const domain of SEARCH_DOMAIN_ORDER) {
    const domainHits = sortHits(
      hits.filter((h) => h.domain === domain),
      query
    ).slice(0, perDomainCap);
    if (domainHits.length > 0) {
      groups.push({
        domain,
        label: SEARCH_DOMAIN_LABELS[domain],
        hits: domainHits,
      });
    }
  }
  return groups;
}

// Flatten grouped results into the top-to-bottom order the arrow keys walk.
export function flattenHits(groups: SearchGroup[]): SearchHit[] {
  return groups.flatMap((g) => g.hits);
}
