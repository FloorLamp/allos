// A COMPOSED ACT, AS ONE ROW ON THE RECORD (#5618 ruling 5).
//
// `/history` listed every row one composed write produced side by side: a usual tap
// wrote two servings and six dose confirms and the record printed eight lines, while
// the Nutrition Day ledger — reading the SAME `bundle_id` — printed one. This is the
// record's half of that reading, and it is deliberately the ledger's rule rather than
// a second one: group on the id the write RECORDED, never on a minute two rows happen
// to share (`lib/day-ledger.ts`, at length), dissolve a group that turns out to hold
// one row, and never let a collapsed row state a time its members disagree about.
//
// PURE. No DB, no clock, no React: `lib/history.ts` reads the facts each row's table
// carries and hands them here, exactly as `lib/queries/day-ledger.ts` feeds
// `buildDayLedger`. That split is what lets the flat case — every row written before
// 2026-09-04, which carries no id at all — be asserted over hand-written rows.
//
// WHAT IT DOES NOT DECIDE. Which rows are on the day, what each one says, and what its
// clock reads are all settled before a row reaches here; this module only decides which
// of them were one act, and what to call it.

import { dayCountsLabel } from "./day-ledger";
import { TIME_BUCKET_LABELS, type TimeBucket } from "./intake-schedule";
import { dosesPhrase } from "./usual-routine";
import type {
  HistoryClock,
  HistoryClockKind,
  HistoryRow,
} from "./history-format";

/**
 * WHAT THE DAY'S TABLES SAY ABOUT ONE ROW'S ACT.
 *
 * One entry per row that RECORDS a bundle. A row with `bundle_id IS NULL` — which is
 * every row written before 2026-09-04, and every single-tap row since — gets no entry
 * at all, so nothing here can key a group on the absence of an id. That is the whole
 * of the flat case, and it is a property of the input rather than a branch below.
 */
export interface HistoryBundleFact {
  /** The composed action that wrote the row (#4328/#5082), as stored. */
  bundleId: string;
  /** A serving's food window ("Morning"), as it was filed. Null on a dose. */
  window: string | null;
  /** A dose's declared stack (`intake_items.stack`, #3098). Null on a serving. */
  stack: string | null;
  /**
   * A dose's time bucket, for the third of #5074 B's spellings ("Morning · 6 doses").
   *
   * THE ROW'S CURRENT SLOT, not the effective-dated one `doseBucketOn` resolves for a
   * past day (#1973) — and that is a deliberate narrowing, not an oversight. This value
   * only ever NAMES a row; nothing files, sorts or counts by it, and the two spellings
   * it chooses between are both true of the act. Every surface that decides where a
   * dose BELONGS still asks the schedule engine, which is the only reader entitled to
   * answer that.
   */
  bucket: TimeBucket | null;
}

/** One composed act, collapsed: the ledger's stack row in the record's vocabulary. */
export interface HistoryBundle {
  kind: "bundle";
  /** `bundle:<bundleId>` — ASCII and unique across the day, like every row id here. */
  id: string;
  bundleId: string;
  /** The act's subject. Every member shares it — one act writes one profile's rows. */
  profileId: number;
  /** The profile-local day the act's rows count for. */
  date: string;
  /** #5074 B's spelling: "Your usual Morning", the stack's name, or the bucket's. */
  title: string;
  /** The act's census, in the ledger's own words: "2 servings · 6 doses". */
  detail: string;
  /** The one clock every member agrees on — the whole reason the collapse is honest. */
  clock: HistoryClock | null;
  clockKind: HistoryClockKind;
  /** The rows this act wrote, in the order the record already put them in. */
  members: HistoryRow[];
  /** `food_log_events.id` for every serving member — the batch cores' first id space. */
  servingIds: number[];
  /** `intake_item_logs.id` for every dose member — the batch cores' second id space. */
  doseLogIds: number[];
}

/** What the record's list holds once acts are collapsed: plain rows and bundle rows. */
export type HistoryEntry = HistoryRow | HistoryBundle;

/** Narrow an entry without every call site re-spelling the discriminant. */
export function isHistoryBundle(entry: HistoryEntry): entry is HistoryBundle {
  return entry.kind === "bundle";
}

// The numeric half of a row id (`dose:41` → 41), which is the identity the correction
// cores take. Read off the row rather than carried a second time: `HistoryRow.id` is
// already `${kind}:${rowId}` by contract and the whole page's tie-break depends on it.
function rowNumber(row: HistoryRow): number | null {
  const raw = Number(row.id.slice(row.id.indexOf(":") + 1));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * WHAT AN ACT IS CALLED (#5074 ruling B, the three spellings ruling 5 names).
 *
 * In order, and the order is the ruling's: an act that wrote FOOD is the usual offer
 * that wrote it, so it wears that offer's own button text; an act that is exactly one
 * declared stack is that stack, "as today" on the ledger; anything else is a bucket
 * take and wears the bucket. The census cell carries the count in every case, so
 * "Your usual Morning" + "6 doses" renders the ruling's "Your usual Morning · 6 doses"
 * without this function ever spelling a number.
 *
 * The last arm is `dosesPhrase`, the repo's existing "name this set of doses" — it
 * cannot reach its own stack arm from here because the stack case is already answered
 * above it, so what it contributes is the enumeration and nothing else.
 */
function bundleTitle(
  facts: readonly HistoryBundleFact[],
  members: readonly HistoryRow[]
): string {
  const one = <T>(values: readonly (T | null)[]): T | null => {
    const set = new Set(values);
    const [only] = set;
    return set.size === 1 && only != null ? only : null;
  };
  const windows = facts.filter((f) => f.window != null).map((f) => f.window);
  if (windows.length > 0) {
    const window = one(windows);
    // #5089's declared names swap in HERE later, with no row change: the ruling is
    // written so a set that has a name of its own replaces the derived spelling and
    // nothing about the grouping, the census or the menu moves.
    if (window) return `Your usual ${window}`;
  }
  const stack = one(facts.map((f) => f.stack));
  if (stack) return stack;
  const bucket = one(facts.map((f) => f.bucket));
  if (bucket) return TIME_BUCKET_LABELS[bucket];
  return dosesPhrase(
    members.map((row, index) => ({
      name: row.title,
      stack: facts[index]?.stack ?? null,
    }))
  );
}

/**
 * COLLAPSE THE DAY'S COMPOSED ACTS, leaving every other row exactly where it was.
 *
 * `facts` is keyed by `HistoryRow.id`. Order is preserved: a bundle takes the position
 * of its FIRST member, so the record's own comparator still decides where the act sits
 * and this function never re-sorts anything.
 *
 * THREE THINGS REFUSE TO COLLAPSE, and each is the ledger's own reason:
 *
 *   • A row with no recorded bundle. Composition is recorded or it is not claimed — so
 *     the pre-2026-09-04 rows, which all carry a null id, stay one row per row. A
 *     grouping keyed on that null would fold a morning and an evening together.
 *   • A bundle with one member on this day. One row is not a composed write however it
 *     was stored, so it reads as itself (`buildDayLedger`'s dissolution loop).
 *   • A bundle whose members do not agree about the time. A collapsed row carries ONE
 *     clock, and the ledger's rule is that a member whose stated clock no longer
 *     matches its tap-mates states its own time instead — so if the act now holds two
 *     different statements, or two different filing clocks with nothing stated, it is
 *     no longer one row and every member states its own.
 *
 *     AN UNSTATED MEMBER IS NOT A DISAGREEMENT, which is the one place this differs
 *     from the ledger's key and the difference is in the data, not the rule. Every
 *     member of a ledger stack row is a taken dose and therefore states a time; a
 *     record bundle also holds SERVINGS, and the usual tap files those as a window
 *     declaration with no eating instant at all (#4438). A row that states nothing has
 *     not stepped out of the act — it never made a claim to contradict — so it joins
 *     the act's one statement, and the collapsed row states the time its stating
 *     members agree on.
 */
export function groupHistoryBundles(
  rows: readonly HistoryRow[],
  facts: ReadonlyMap<string, HistoryBundleFact>
): HistoryEntry[] {
  const membersOf = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const fact = facts.get(row.id);
    if (!fact) continue;
    const list = membersOf.get(fact.bundleId);
    if (list) list.push(row);
    else membersOf.set(fact.bundleId, [row]);
  }

  const collapsed = new Map<string, HistoryBundle>();
  for (const [bundleId, members] of membersOf) {
    if (members.length < 2) continue;
    const stated = members.filter((row) => row.clockKind === "stated");
    const spoken = stated.length > 0 ? stated : members;
    const clocks = new Set(spoken.map((row) => row.clock));
    if (clocks.size !== 1) continue;
    const memberFacts = members.map((row) => facts.get(row.id)!);
    const servingIds: number[] = [];
    const doseLogIds: number[] = [];
    for (const row of members) {
      const id = rowNumber(row);
      if (id == null) continue;
      if (row.kind === "food") servingIds.push(id);
      else if (row.kind === "dose") doseLogIds.push(id);
    }
    const first = members[0]!;
    collapsed.set(bundleId, {
      kind: "bundle",
      id: `bundle:${bundleId}`,
      bundleId,
      profileId: first.profileId,
      date: first.date,
      title: bundleTitle(memberFacts, members),
      detail: dayCountsLabel(servingIds.length, doseLogIds.length),
      clock: spoken[0]!.clock,
      clockKind: spoken[0]!.clockKind,
      members,
      servingIds,
      doseLogIds,
    });
  }

  const out: HistoryEntry[] = [];
  const placed = new Set<string>();
  for (const row of rows) {
    const bundleId = facts.get(row.id)?.bundleId;
    const bundle = bundleId != null ? collapsed.get(bundleId) : undefined;
    if (!bundle) {
      out.push(row);
      continue;
    }
    if (placed.has(bundle.bundleId)) continue;
    placed.add(bundle.bundleId);
    out.push(bundle);
  }
  return out;
}
