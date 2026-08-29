import { Fragment } from "react";
import Link from "next/link";
import { IconChevronDown } from "@tabler/icons-react";
import PageContainer from "@/components/PageContainer";
import DestinationLink from "@/components/DestinationLink";
import { PageHeader, EmptyState } from "@/components/ui";
import Chip from "@/components/Chip";
import FilterPills from "@/components/FilterPills";
import JumpRailScrubber, {
  type ScrubberStop,
} from "@/components/JumpRailScrubber";
import DoseBackfillLauncher from "@/components/intake/DoseBackfillLauncher";
import TimelineFilterLink from "@/components/TimelineFilterLink";
import type { DoseLedgerItem } from "@/components/intake/dose-ledger-entry";
import HistoryRows from "./HistoryRows";
import HistoryAddDoor from "./HistoryAddDoor";
import { requireScope } from "@/lib/scope";
import { today } from "@/lib/db";
import { zonedDateParts } from "@/lib/date";
import {
  getDisplayFormatPrefs,
  getTimezone,
  getUnitPrefs,
} from "@/lib/settings";
import { getIntakeDoses, getIntakeItems } from "@/lib/queries";
import { getTrackedPractices } from "@/lib/queries/wellness";
import { getProfileSubstanceKeys } from "@/lib/queries/substance";
import { substanceDef } from "@/lib/substance-use";
import { isOnDemand } from "@/lib/intake-schedule";
import { formatLongDate } from "@/lib/format-date";
import { historyHref, type AppRoute } from "@/lib/hrefs";
import { historyMemberFeed } from "@/lib/history";
import {
  HISTORY_DEFAULT_SHOW,
  HISTORY_FAMILIES,
  HISTORY_FAMILY_KINDS,
  HISTORY_FAMILY_LABELS,
  HISTORY_KIND_LABELS,
  HISTORY_KINDS,
  HISTORY_LOG_KINDS,
  HISTORY_MAX_SHOW,
  HISTORY_SHOW_STEP,
  clampHistoryDay,
  historyKindFamily,
  layoutHistoryDay,
  parseHistoryExpand,
  parseHistoryShow,
  resolveHistoryDoseClass,
  resolveHistoryFamily,
  resolveHistoryKind,
  type HistoryFamily,
  type HistoryKind,
  type HistoryRow,
} from "@/lib/history-format";
import { mergeMemberTimelines } from "@/lib/timeline-multi";
import {
  parseTimelineOpen,
  renderedTimelineDays,
  timelineFoldCounts,
  toggledTimelineOpen,
  windowTimelineDays,
  type TimelineFold,
} from "@/lib/timeline-window";
import {
  SCRUBBER_GUTTER_CLASS,
  showTimelineScrubber,
  timelineScrubberTicks,
} from "@/lib/timeline-scrubber";

export const dynamic = "force-dynamic";

// `/history` — THE APP'S RECORD (issue #3958, phase 1).
//
// Every discrete thing a profile logged, day-grouped, newest first, correctable in
// place. It replaced the four standalone ledger routes — two dose doors, one for food
// and one for practices — which were four copies of one page differing only in which
// table they read, and which each answered "when" and "how much" in their own words.
// There are no redirects: those routes are gone and every door that pointed at one now
// points here, because a shim is a compatibility layer standing where a fixed call site
// should be. Their paths are deliberately not spelled anywhere in the tree, so
// `git grep` answering nothing IS the acceptance criterion.
//
// WHAT THIS FILE OWNS. The URL → read → render seam, and nothing about a domain: the
// row grammar is lib/history-format.ts's, the composers are lib/history.ts's, the
// folds and the rail are #2657's (shared verbatim with /timeline until phase 2 retires
// it), and every write is the domain's own Server Action reached through HistoryRows.
//
// THE CHROME BUDGET IS AN ACCEPTANCE CRITERION: ≤ ~140px above the first record at
// 390px. What buys that is stated so an addition has to name what it displaces — no
// h1/subtitle below `sm` (#1616/#1661: the nav already names the page), ONE filter row,
// NO range chrome at all (the record is navigated, not windowed), and day headers that
// stick rather than repeating a date on every row.
//
// A BAD DEEP LINK DEGRADES TO THE PAGE. Every parser here answers "or All": an unknown
// kind, a retired family, a future day. A record surface that 404s on a hand-edited
// URL is a record you cannot get back to.
//
// ── THE #2657 SCROLL RESTORER IS DELIBERATELY NOT MOUNTED HERE ───────────────
//
// Written down because the next reader WILL find `TimelineScrollRestorer` exported
// beside the `TimelineFilterLink` this page uses on every chip and every fold card,
// see it mounted on `/timeline` and not here, and read that as a re-housing that got
// dropped. It is a decision.
//
// WHAT IT DOES: on a chip tap it records the day sitting under the filter controls,
// and after the navigation scrolls that day back under them. On `/timeline` that is
// right — the filter row and the date-range control re-query the whole feed, so
// without it the reader is left at an offset that no longer means anything.
//
// WHY NOT HERE: #4062 re-nested the folds so an open month's days render UNDER their
// own card, and paired that with `scroll={false}` so opening one leaves the reader
// looking at the card they tapped. The restorer's capture target is the DAY under the
// controls, which after a fold tap is not the fold card — so mounting it as-is would
// scroll the reader AWAY from the card they just opened, undoing the fix. The two
// answers to "where should the reader be afterwards" disagree, and the fold arrangement
// already gives the better one for the taps that dominate this page.
//
// The chips are the case that would still benefit, and separating them would mean a
// per-link flag on the shared control — a second shape of one component selected by a
// prop, which is the variant the line-budget ruling names outright. Not worth it for
// the chip case alone, so this is raised rather than built.
//
// NOTHING IS LEAKING IN THE MEANTIME: the capture in `TimelineFilterLink`'s onClick
// looks up `#timeline-controls`, which exists only on `/timeline`, so on this page it
// finds nothing and returns without writing. It is inert here, not half-wired — and
// when `/timeline` retires, the capture and the restorer retire with it unless this
// decision is revisited first.

// One collapsed period — a month of the current year, or an earlier year (#2657).
// Deliberately the same shape and the same `timeline-fold-` anchor id the timeline
// draws: the rail's stops are computed from those ids, and phase 2 moves that feed
// onto this page rather than reconciling two vocabularies.
function FoldCard({
  fold,
  href,
  gutter,
  nested = false,
}: {
  fold: TimelineFold<{ date: string; events: unknown[] }> & {
    monthCount?: number;
  };
  href: AppRoute;
  /** The rail's lane, when the rail renders — see the feed container's note. */
  gutter: string;
  nested?: boolean;
}) {
  return (
    <section
      id={`timeline-fold-${fold.key}`}
      data-testid={`history-fold-${fold.key}`}
      data-fold-key={fold.key}
      data-fold-open={fold.open ? "true" : "false"}
      className={`scroll-mt-24 py-1.5 ${nested ? "pl-4" : ""} ${gutter}`}
    >
      {/* THE POSITION-PRESERVING LINK, NOT A PLAIN ONE (#4045 §4). This shipped as a
          `next/link` with default scroll, so every fold tap navigated to `?open=…` and
          jumped to the top of the page: the reader tapped a card, landed above their
          own recent history, saw nothing new, and read the card as dead. `/timeline`'s
          fold cards never did that because they go through this component, which
          carries `scroll={false}` and the #2657 scroll-target capture — the re-housing
          simply dropped it. Reused rather than re-spelled: a second copy of a
          scroll-preserving link is the duplication #2816 was filed about.

          `scroll={false}` ALONE IS NOT THE FIX; the other half is where the revealed
          days render, below. */}
      <TimelineFilterLink
        href={href}
        testId={`history-fold-${fold.key}-toggle`}
        label={fold.label}
        ariaExpanded={fold.open}
        className="flex items-center gap-3 rounded-lg border border-(--border) bg-surface px-3 py-2 transition hover:bg-(--ghost-hover)"
      >
        <span
          aria-hidden
          className={`inline-flex h-5 w-5 shrink-0 items-center justify-center text-slate-500 transition dark:text-slate-400 ${
            fold.open ? "rotate-180" : ""
          }`}
        >
          <IconChevronDown className="h-3.5 w-3.5" stroke={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
            {fold.label}
          </span>
          <span className="block text-xs text-slate-500 dark:text-slate-400">
            {timelineFoldCounts(fold)}
          </span>
        </span>
      </TimelineFilterLink>
    </section>
  );
}

export default async function HistoryPage(props: {
  searchParams: Promise<{
    family?: string | string[];
    kind?: string | string[];
    class?: string | string[];
    item?: string | string[];
    media?: string | string[];
    day?: string | string[];
    view?: string | string[];
    open?: string | string[];
    expand?: string | string[];
    show?: string | string[];
  }>;
}) {
  const searchParams = await props.searchParams;
  const scope = await requireScope();
  const { loginId, actingProfileId, viewIds } = scope;
  const todayStr = today(actingProfileId);
  const prefs = getDisplayFormatPrefs(loginId);

  // A kind IMPLIES its family, so `?family=` only matters when no kind is named. Phase
  // 1 ships the Logs family alone: a `?family=clinical` link written against phase 2
  // resolves, finds nothing of that family here, and falls back to All rather than
  // 404ing.
  const kind = resolveHistoryKind(searchParams.kind);
  const family = resolveHistoryFamily(searchParams.family);
  const doseClass = resolveHistoryDoseClass(searchParams.class);
  const rawItem = Array.isArray(searchParams.item)
    ? searchParams.item[0]
    : searchParams.item;
  const media =
    (Array.isArray(searchParams.media)
      ? searchParams.media[0]
      : searchParams.media) === "1";
  const day = clampHistoryDay(searchParams.day, todayStr);
  const show = parseHistoryShow(searchParams.show);
  const openFolds = parseTimelineOpen(searchParams.open);
  // THE ROLLUP LINES THE READER HAS OPENED (#3958 phase 2). A second param beside
  // `?open=` because they are different questions with different key vocabularies —
  // `parseTimelineOpen` validates a year, a month or the ahead key, and a rollup key is
  // a (day, member) pair. Same toggle helper, so the URL stays sorted and stable.
  const expanded = parseHistoryExpand(searchParams.expand);

  // THE HOUSEHOLD VIEW IS A DEEP-LINKED MODE, NOT A SWITCHER (#1463): the sidebar is
  // the one profile switcher on every page, so this costs the chrome budget nothing.
  // It composes the SAME per-profile gather once per member — which is what makes
  // every visibility rule (age gates, substance exclusions) inherited per row rather
  // than re-derived across a widened query.
  const everyone =
    (Array.isArray(searchParams.view)
      ? searchParams.view[0]
      : searchParams.view) === "everyone" && viewIds.length > 1;
  const memberIds = everyone ? viewIds : [actingProfileId];

  const feeds = memberIds.map((id) =>
    historyMemberFeed(id, {
      loginId,
      kind,
      family,
      doseClass,
      item: rawItem,
      media,
      day,
      limit: show,
    })
  );
  const presentKinds = HISTORY_KINDS.filter((candidate) =>
    feeds.some((feed) => feed.gather.presentKinds.includes(candidate))
  );
  // A FAMILY CHIP IS EARNED BY ITS KINDS, so an empty family never advertises itself —
  // the substance quiet-access posture applied uniformly, as #3958 asks. Derived from
  // the same presence answer the refinement row uses, so the two rows cannot disagree.
  const presentFamilies = HISTORY_FAMILIES.filter((candidate) =>
    HISTORY_FAMILY_KINDS[candidate].some((k) => presentKinds.includes(k))
  );
  // WHICH FAMILY THE PAGE IS IN. A kind implies its family, so a refinement row is
  // showing whenever either is set — and never in All, which is the issue's own rule.
  const activeFamily: HistoryFamily | null = kind
    ? historyKindFamily(kind)
    : (family ?? null);
  // WHETHER THE PHOTOS FILTER IS ON, as the gather answers it rather than as the URL
  // asks: `?media=1` degrades when no row can satisfy it, so the chip must not paint
  // itself pressed over a page that is showing everything.
  const mediaApplied = feeds.some((feed) => feed.gather.mediaApplied);
  const hasMedia = feeds.some((feed) =>
    feed.gather.rows.some((row) => row.media > 0)
  );

  // ONE grouping engine for one member and for five (#1329/#221). The within-day
  // order is its comparator's: instant descending, date-only rows sinking below timed
  // ones, and a same-instant tie-break on id — which is what makes the order
  // byte-stable when one usual-routine tap writes six rows in the same minute.
  const allDays = mergeMemberTimelines(feeds);
  const days = allDays.slice(0, undefined);

  // WINDOWING (#2657), except on the day view: a day IS the window, and folding it
  // would fold the surface's whole content away. There is no `ahead` fold to draw —
  // the gather already ends the record at now.
  const windowed = day ? null : windowTimelineDays(days, todayStr, openFolds);
  const renderedDays = windowed ? renderedTimelineDays(windowed) : days;

  // SWITCHING KIND DROPS WHAT BELONGED TO THE OLD ONE — the deleted ledger's rule
  // ("an item belongs to one kind, so carrying it across would leave a filter naming
  // nothing"), applied to both kind-scoped params. `class` is the DOSE two-door
  // pre-filter and means nothing on any other kind, so a chip that leaves doses must
  // not carry it: a row of chips whose "All" still says `class=medication` is a
  // control that does not do what it is called.
  const chipHref = (next: {
    kind?: HistoryKind;
    family?: HistoryFamily;
    media?: boolean;
  }): AppRoute => {
    const nextKind = "kind" in next ? next.kind : kind;
    // A FAMILY CHIP DROPS THE KIND INSIDE IT. Moving to Clinical while `?kind=dose` was
    // set would produce a URL that contradicts itself (a kind implies its family), and
    // `historyHref` resolves that by dropping the family — so the Clinical chip would
    // have navigated back to Doses.
    const nextFamily = "family" in next ? next.family : "kind" in next ? undefined : family;
    return historyHref({
      family: nextKind ? undefined : nextFamily,
      kind: nextKind,
      class: nextKind === "dose" ? doseClass : undefined,
      item: "kind" in next || "family" in next ? undefined : rawItem,
      media: next.media ?? mediaApplied,
      day,
      everyone,
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    });
  };

  // THE ROLLUP LINE'S OWN LINK — the same toggle helper the folds use, so the `?expand`
  // set is sorted and the href for a given open set is byte-identical across renders.
  const expandHref = (key: string): AppRoute =>
    historyHref({
      family: kind ? undefined : family,
      kind,
      class: doseClass,
      item: rawItem,
      media: mediaApplied,
      day,
      everyone,
      open: [...openFolds].sort(),
      expand: toggledTimelineOpen(expanded, key),
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    });

  const foldHref = (
    key: string,
    fold?: { open: boolean; descendants: readonly string[] },
    anchor?: string
  ): AppRoute => {
    const base = historyHref({
      family: kind ? undefined : family,
      kind,
      class: doseClass,
      item: rawItem,
      media: mediaApplied,
      day,
      everyone,
      open: toggledTimelineOpen(openFolds, key, fold),
      expand: [...expanded].sort(),
      show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
    });
    return anchor ? (`${base}#${anchor}` as AppRoute) : base;
  };

  // THE JUMP RAIL (#2657 item 4) — stops derived from what THIS render put in the
  // document, so a month sealed inside a collapsed year never gets a tick the scroll
  // cannot keep. It owns a lane: `SCRUBBER_GUTTER_CLASS` is the rail's intrusion into
  // the content column, applied to every surface underneath it, so the strip never
  // overlays a row's action column.
  const ticks = windowed ? timelineScrubberTicks(windowed) : [];
  const stops: ScrubberStop[] = showTimelineScrubber(ticks)
    ? ticks.map((tick) => ({
        ...tick,
        href: tick.openKey
          ? foldHref(tick.openKey, undefined, tick.anchorId)
          : null,
      }))
    : [];
  // SPENDING THE RAIL'S LANE, AND AT WHAT DEPTH (#4045 §2, owner ruling 2026-08-29).
  //
  // THE LANE DOES NOT EXIST ON A WIDE VIEWPORT, which is #3958's own spec — "on wide
  // viewports it sits in the margin beside the card; on narrow desktops the page
  // reserves a right gutter". The strip is fixed to the VIEWPORT's right edge, and from
  // `xl` the margin between the reading column and that edge is already wider than the
  // strip, so nothing is reserved and every card runs the full width of the feed.
  //
  // BELOW `xl` THE CARVE-OUT IS SPENT AT ONE DEPTH FOR EVERY CARD — the day SECTION and
  // the fold SECTION, siblings inside `#history-feed`. The shipped page spent it at TWO
  // depths (the fold's outer section, the day's inner row wrapper) at every width, so
  // the day band's border ran 28px past every fold card's.
  //
  // BELOW `sm` IS THE ONE EXCEPTION and it is #3920's shape, not a drift: the band goes
  // full-bleed there, so a gutter on its section would stop the fill reaching the edge
  // and strand a strip of page beside it. The ROW content spends the lane instead, and
  // the band has no side border at that width for anything to align with.
  //
  // The responsive halves are spelled as literals rather than composed from
  // `SCRUBBER_GUTTER_CLASS`, because Tailwind scans source text for whole class names
  // and an interpolated `sm:${TOKEN}` generates no CSS at all. What holds them to the
  // token is not a second literal but the geometry guard in e2e/history.spec.ts, which
  // measures the two card edges at two widths and reads no class string.
  const railGutter = stops.length > 0 ? `${SCRUBBER_GUTTER_CLASS} xl:pr-0` : "";
  const dayGutter = stops.length > 0 ? "sm:pr-7 xl:pr-0" : "";
  const rowGutter = stops.length > 0 ? `${SCRUBBER_GUTTER_CLASS} sm:pr-0` : "";

  // The dose form's vocabulary, read once for the whole page: which items exist (an
  // item retired since the dose was taken still took it, so history keeps listing it)
  // and which of them still have a live dose to log against.
  const allItems = getIntakeItems(actingProfileId);
  const dosesByItem = new Map<
    number,
    { id: number; amount: string | null; time_of_day: string | null }[]
  >();
  for (const dose of getIntakeDoses(actingProfileId)) {
    const list = dosesByItem.get(dose.item_id) ?? [];
    list.push({
      id: dose.id,
      amount: dose.amount,
      time_of_day: dose.time_of_day,
    });
    dosesByItem.set(dose.item_id, list);
  }
  const doseItems: DoseLedgerItem[] = allItems.map((item) => ({
    id: item.id,
    name: item.name,
    kind: item.kind,
    product: item.product,
    asNeeded: isOnDemand(item),
    doses: dosesByItem.get(item.id) ?? [],
  }));
  const loggable = doseItems.filter((item) => item.doses.length > 0);
  const canWrite = scope.access.get(actingProfileId) === "write";
  // WHICH PROFILES IN VIEW THIS LOGIN MAY WRITE (#4009 item 1 / #2106). Resolved once
  // from the scope's already-computed access map — no second `accessForProfile` pass —
  // and handed to the rows as a SET, because in `?view=everyone` the answer differs per
  // member: a caregiver can hold write on one and read-only on another. This decides
  // whether the ⋯ is DRAWN. It is not the gate: the gate is `gateItemProfile` inside
  // each correction action, which re-checks at apply time, so a forged submit naming a
  // profile this login cannot write is refused whatever this list said.
  const writableProfileIds = memberIds.filter(
    (id) => scope.access.get(id) === "write"
  );
  // AND EACH MEMBER'S OWN TODAY (#4009 item 1). A correction's date field may reach
  // that member's current day and no further — which is not the caregiver's, for a
  // member in a zone ahead of theirs. The server already bounds on the gated profile;
  // this is the client half saying the same thing.
  const maxDates = Object.fromEntries(memberIds.map((id) => [id, today(id)]));
  // THE OTHER FOUR DOORS' VOCABULARY, read once and only for the kind that is showing
  // one. Each list is a shared reader the kind's own surface already uses — no fifth
  // derivation of "what can this profile log".
  // WHICH KINDS THE ADD DOOR CAN BE (#3958: "Log kinds only"). Clinical, training and
  // life records are created on their domain surfaces, and the two remaining Logs kinds
  // are not declared either: sleep arrives from an integration and is corrected at its
  // source, and a symptom is quick-logged — the day view mounts the bar that does it.
  const addKind =
    kind === "food" ||
    kind === "practice" ||
    kind === "substance" ||
    kind === "body"
      ? kind
      : null;
  const addVocabulary =
    canWrite && addKind
      ? {
          practices:
            addKind === "practice"
              ? getTrackedPractices(actingProfileId).map((p) => p.name)
              : [],
          substances:
            addKind === "substance"
              ? getProfileSubstanceKeys(actingProfileId).map((key) => ({
                  key,
                  label: substanceDef(key).label,
                }))
              : [],
          weightUnit: getUnitPrefs(loginId).weightUnit,
        }
      : null;
  // WHETHER THIS KIND HAS A DOOR AT ALL — the dose door's own presence rule, which the
  // other kinds inherit: a picker with nothing in it is worse than no control. A kind
  // that cannot offer one falls back to the kind chooser rather than to an empty row,
  // which is what the dose branch already did.
  const hasAddDoor = addVocabulary
    ? addKind === "practice"
      ? addVocabulary.practices.length > 0
      : addKind === "substance"
        ? addVocabulary.substances.length > 0
        : true
    : kind === "dose" && loggable.length > 0;
  const defaultTime = zonedDateParts(
    getTimezone(actingProfileId),
    new Date()
  ).hhmm;
  const subjectNames: Record<number, string> = {};
  if (everyone) {
    for (const profile of scope.profiles) {
      if (viewIds.includes(profile.id)) subjectNames[profile.id] = profile.name;
    }
  }

  // WHETHER THE DAY'S LOG ROWS COLLAPSE (#3958 phase 2).
  //
  // EVERYTHING ONLY, and the two exclusions are the issue's own words. "Filtered to a
  // family, the page behaves as the plain record": a reader who asked for Logs is
  // asking for the rows, and a rollup would answer by hiding them. "Day-view rows are
  // flat — no rollups; a day view lists everything": the day view is the surface you
  // open to see the whole day, so collapsing it there would defeat the visit.
  const rollup = day == null && kind == null && family == null;

  // ONE DAY GROUP, wherever it lands: in the recent band, or nested under the fold that
  // was holding it. Written once because the fold arrangement renders it from three
  // places (recent, an open month, an open month inside an open year), and three copies
  // of a sticky header is how two of them drift.
  const daySection = (group: (typeof days)[number]) => (
    <section
      key={group.date}
      id={`timeline-day-${group.date}`}
      data-testid="history-day"
      className={`scroll-mt-24 pb-2 pt-1 ${dayGutter}`}
    >
      {/* THE DAY HEADER STICKS, and it is the whole "which day am I in" affordance —
          there is no per-row date cell, which is most of what the one-line row buys.
          THE WHOLE TEXT CLUSTER IS THE DOOR and it carries a chevron (#4045 §7): the
          header shipped with only its date text linked and no chevron at all, so the
          count sat outside the tap target and nothing said the header was a door. The
          chevron sits IN the cluster — nothing is right-floated, per the spec's own
          words. (Phase 2 renders the day view; the link is already the real one.) */}
      <h2 className="sticky top-0 z-10 -mx-1 mb-1 bg-(--page) px-1 py-1 text-sm font-semibold text-slate-800 dark:text-slate-100">
        {/* THE ONE RIGHTWARD DESTINATION CUE, not a hand-rolled chevron: the glyph and
            its geometry belong to the primitive (lib/__tests__/destination-link-primitive
            .test.ts refuses a raw one inside a link). Its `ml-auto` costs nothing here
            because the link is `inline-flex` and sized to its own content — the cue
            sits IN the text cluster, and nothing is right-floated. */}
        <DestinationLink
          // THE READER'S OWN BOUND RIDES ACROSS. Without `show` a day opened at
          // `HISTORY_DEFAULT_SHOW`, so a busy day truncated on first open even though
          // the page it was opened from had already been widened.
          href={historyHref({
            day: group.date,
            everyone,
            show: show === HISTORY_DEFAULT_SHOW ? undefined : show,
          })}
          className="inline-flex items-baseline gap-2 hover:underline"
          data-testid="history-day-link"
        >
          <span>{formatLongDate(group.date, prefs)}</span>
          {/* THE SEPARATOR IS LOAD-BEARING, not decoration. #3958 writes this header
              as "FRI, AUG 28 — 15 records" and the implementation dropped the dash;
              with the count promoted INSIDE the link (above), the two spans then sat
              adjacent with nothing between them, so the cluster's `textContent` read
              "…August 295 records" — the date's last digit running into the count's
              first. `gap-2` separates them for an eye and for nothing else: anything
              reading the cluster linearly sees one run. That is not hypothetical —
              e2e/machine-date-census.spec.ts finds this header by matching a display
              date with `\d{1,2}\b`, and "29" followed by "5" has no word boundary
              after it, so its positive control stopped being able to see a date here
              at all. Restoring the dash puts the rendered shape back to the spec's
              own and makes the text content honest in the same stroke. */}
          <span aria-hidden className="text-slate-500 dark:text-slate-400">
            —
          </span>
          <span className="text-xs font-normal text-slate-500 dark:text-slate-400">
            {group.events.length} record
            {group.events.length === 1 ? "" : "s"}
          </span>
        </DestinationLink>
      </h2>
      <HistoryRows
        rows={layoutHistoryDay(group.events as HistoryRow[], { rollup }).visible}
        rollups={layoutHistoryDay(group.events as HistoryRow[], {
          rollup,
        }).rollups.map((line) => ({
          ...line,
          href: expandHref(line.key),
          open: expanded.has(line.key),
        }))}
        actingProfileId={actingProfileId}
        writableProfileIds={writableProfileIds}
        doseItems={doseItems}
        maxDates={maxDates}
        defaultTime={defaultTime}
        subjectNames={subjectNames}
        rowClassName={rowGutter}
        // A VIEW NARROWED TO ONE KIND DRAWS NO GLYPH COLUMN (#4045 §3), extending
        // #3958's rule that the column collapses in views that render no glyphs. Asked
        // of the VIEW and not of the rows: All is still All when a profile happens to
        // have logged only food this week, and its next row could be any kind.
        showGlyphs={kind == null}
      />
    </section>
  );

  const rowCount = renderedDays.reduce((n, d) => n + d.events.length, 0);
  const hasMore = feeds.some((feed) => feed.gather.hasMore);

  return (
    <PageContainer
      width="reading"
      className="mx-auto"
      data-testid="history-page"
    >
      <PageHeader
        title="History"
        subtitle="Everything recorded, newest first."
        compactBelowSm
        className={railGutter}
      />

      {/* ONE FILTER ROW, AND IT IS ONE LINE. Kind chips on the shared responsive
          pill group (#3938's control box, phone-scroll / `sm`-wrap), data-presence
          earned so an empty category never advertises itself, plus the Photos toggle
          behind a hairline — a cross-cutting filter, never a renderer switch. No
          counts on chips: the day headers count. A WRAPPING row was the first thing
          that blew the chrome budget here, which is why the kinds scroll and the
          toggle is pinned outside the scroller rather than wrapping under it.

          Phase 1 renders the Logs family's KIND row directly rather than a family row
          that would hold one entry; `?family=` still resolves.

          `gap-3` on both control rows, which is the gap `FilterPills` already spends
          between its own pills: the reach a coarse pointer gets around a 34px box is
          (44 - 34) / 2 per side, so two adjacent extended targets need TWICE that
          between them, and #3938 made `gap-3` the one gap every pill layout uses.
          MEASURED HONESTLY: `gap-2` here also cleared the floor, because the hairline
          divider sits between the two clusters and is itself gapped on both sides —
          so this is agreement with the shared row, not a defect that was found. */}
      <div
        className={`mb-3 flex items-center gap-3 ${railGutter}`}
        data-testid="history-filters"
      >
        <div className="min-w-0 flex-1">
          {/* THE FAMILY ROW (#3958 phase 2): All · Logs · Training · Clinical · Life.
              Phase 1 rendered the Logs KIND row here because Logs was the only family
              that existed; with four, the top row is families and the kinds move to
              the refinement row below. Still ONE row in the header stack — the
              refinement row renders only inside a family, never in All, so the chrome
              budget above the first record is unchanged in the view that has to meet
              it. */}
          <FilterPills
            mode="link"
            layout="responsive"
            linkBehavior="timeline"
            label="Filter the record by family"
            value={activeFamily}
            testId="history-family-pills"
            options={[
              {
                value: null,
                label: "All",
                href: chipHref({ kind: undefined, family: undefined }),
                testId: "history-chip-all",
              },
              ...presentFamilies.map((candidate) => ({
                value: candidate as HistoryFamily | null,
                label: HISTORY_FAMILY_LABELS[candidate],
                href: chipHref({ kind: undefined, family: candidate }),
                testId: `history-chip-family-${candidate}`,
              })),
            ]}
          />
        </div>
        {hasMedia || mediaApplied ? (
          <>
            <span
              aria-hidden
              className="h-5 w-px shrink-0 bg-black/10 dark:bg-white/10"
            />
            <span className="shrink-0">
              <Chip
                role="filter"
                href={chipHref({ media: !mediaApplied })}
                current={mediaApplied}
                linkBehavior="timeline"
                testId="history-chip-media"
              >
                Photos
              </Chip>
            </span>
          </>
        ) : null}
      </div>

      {/* THE KIND-SCOPED REFINEMENT ROW, PER FAMILY — "never in All" (#3958). It is a
          SECOND row and it only exists once the reader has already chosen a family, so
          the ≤140px chrome budget is measured where it is stated: on the page as it
          first loads, which is All. Every chip is presence-earned from the same answer
          the family row used, so a family cannot offer a kind it has no rows for. */}
      {activeFamily ? (
        <div className={`mb-3 ${railGutter}`} data-testid="history-kind-row">
          <FilterPills
            mode="link"
            layout="responsive"
            linkBehavior="timeline"
            label={`Filter ${HISTORY_FAMILY_LABELS[activeFamily]} by kind`}
            value={kind ?? null}
            testId="history-kind-pills"
            options={[
              {
                value: null,
                label: HISTORY_FAMILY_LABELS[activeFamily],
                href: chipHref({ kind: undefined, family: activeFamily }),
                testId: `history-chip-${activeFamily}-all`,
              },
              ...HISTORY_FAMILY_KINDS[activeFamily]
                .filter((candidate) => presentKinds.includes(candidate))
                .map((candidate) => ({
                  value: candidate as HistoryKind | null,
                  label: HISTORY_KIND_LABELS[candidate],
                  href: chipHref({ kind: candidate }),
                  testId: `history-chip-${candidate}`,
                })),
            ]}
          />
        </div>
      ) : null}

      {/* THE ADD DOOR, KIND-RESOLVED. Filtered to a kind it IS that kind's backfill,
          MOUNTED IN PLACE — the form opens here rather than sending the reader to the
          domain surface, which is what #3958 asked for and what only the dose kind
          shipped (#4045 §1). Log kinds only — clinical, training and life records are
          created on their own surfaces — and never the future: every door here is
          bounded by today. */}
      {canWrite ? (
        <div className={`mb-2 text-sm ${railGutter}`} data-testid="history-add">
          {!hasAddDoor ? (
            /* IN ALL — AND IN A KIND WITH NOTHING TO OFFER — THE DOOR ASKS THE KIND
               FIRST, which on a record page is the same act as narrowing to it. It
               scrolls rather than wraps for the same reason the filter row does. */
            <div className="-mx-2 flex items-center gap-3 overflow-x-auto px-2 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
              <span className="shrink-0 text-slate-500 dark:text-slate-400">
                Add past
              </span>
              {HISTORY_LOG_KINDS.filter(
                (candidate) =>
                  candidate !== "sleep" &&
                  candidate !== "symptom" &&
                  (presentKinds.length === 0 ||
                    presentKinds.includes(candidate))
              ).map(
                (candidate) => (
                  <Link
                    key={candidate}
                    className="btn-ghost btn-sm shrink-0"
                    href={chipHref({ kind: candidate })}
                    data-testid={`history-add-${candidate}`}
                  >
                    {HISTORY_KIND_LABELS[candidate]}
                  </Link>
                )
              )}
            </div>
          ) : kind === "dose" ? (
            <DoseBackfillLauncher
              loggable={loggable}
              maxDate={todayStr}
              defaultTime={defaultTime}
            />
          ) : addVocabulary && addKind ? (
            <HistoryAddDoor
              kind={addKind}
              // THE DAY THE READER WAS LOOKING AT. Finding a gap is the reason to open
              // this door at all, so the form opens on that day rather than on today —
              // the context the redirect used to throw away.
              date={day ?? todayStr}
              maxDate={todayStr}
              vocabulary={addVocabulary}
            />
          ) : null}
        </div>
      ) : null}

      {rowCount === 0 ? (
        <EmptyState
          message={
            kind || media || day
              ? "Nothing recorded here yet."
              : "Nothing recorded yet. Anything logged shows up here."
          }
        />
      ) : null}

      {/* THE FEED CONTAINER TAKES NO RAIL GUTTER, and that is the #3920 shape rather
          than an oversight: below `sm` the row band is FULL-BLEED, so a gutter on its
          container would stop the fill reaching the edge and leave a 28px strip of
          page beside it. The rail's lane is spent by the row CONTENT and by the day
          headers instead — "the band fill stays full-bleed while row content ends
          short of the edge". */}
      <div data-testid="history-feed">
        {(windowed ? windowed.recent : days).map(daySection)}
        {/* READING ORDER: the recent band first, then this year's older months, then
            one card per earlier year. A fold card above the days would put a stack of
            shut doors between the reader and their own recent history, which is the
            defect #2657 exists to prevent — and it would spend the chrome budget on
            content nobody asked to see.

            AN OPEN MONTH'S DAYS RENDER RIGHT HERE, UNDER ITS OWN CARD (#4045 §4), which
            is the arrangement `/timeline` has always had. Shipped, this page appended
            every open month's days to the day feed ABOVE the whole fold stack, so a tap
            revealed content nowhere near the card that revealed it: with the scroll
            preserved, the reader was left looking at a card that had visibly done
            nothing but rotate a chevron. Chronological order is unchanged — the fold
            stack is newest-first and so are each fold's days, so this is a re-nesting
            and not a re-ordering — and with the fold card holding its place, opening
            lands the revealed days directly beneath the tap and closing leaves the
            reader on the card they tapped. */}
        {windowed?.months.map((fold) => (
          <Fragment key={fold.key}>
            <FoldCard
              fold={fold}
              gutter={railGutter}
              href={foldHref(fold.key)}
            />
            {fold.open ? fold.days.map(daySection) : null}
          </Fragment>
        ))}
        {windowed?.years.map((year) => (
          <Fragment key={year.key}>
            <FoldCard
              fold={year}
              gutter={railGutter}
              href={foldHref(year.key, {
                open: year.open,
                descendants: year.months.map((month) => month.key),
              })}
            />
            {year.open
              ? year.months.map((month) => (
                  <Fragment key={month.key}>
                    <FoldCard
                      fold={month}
                      gutter={railGutter}
                      href={foldHref(month.key)}
                      nested
                    />
                    {month.open ? month.days.map(daySection) : null}
                  </Fragment>
                ))
              : null}
          </Fragment>
        ))}
      </div>

      {/* LOAD MORE, OR THE SENTENCE THAT SAYS WHY THERE ISN'T ONE.
          `?show` is clamped at `HISTORY_MAX_SHOW`, so at the ceiling the control was a
          button whose URL changed and whose page did not. A control that does nothing
          is worse than no control, because it answers "is there more" with a promise
          instead of a fact.

          AND SO IS A SENTENCE THAT NAMES A ROUTE BACK TO THE SAME ROWS. This said
          "Narrow to one kind, or open a day, to read further back", and the first half
          was FALSE: `limit` is applied per kind inside the gather — `wants()` decides
          WHETHER a kind is read, never how much — so the All view already reads every
          kind to `show`, and the chip carries `show` across, landing the narrowed view
          on the identical rows. Measured: 0 rows revealed, same oldest date either
          side. That is worse than the inert button it replaced, because it spends the
          reader's trust as well as their tap.

          So the page says only what it knows: how much it is showing. The ceiling
          stays — it is what keeps one kind's read off the whole store — and phase 2's
          day view is where "further back" gets a real answer. */}
      {hasMore ? (
        <div className={`mt-4 ${railGutter}`}>
          {show < HISTORY_MAX_SHOW ? (
            <Link
              className="btn-ghost btn-sm"
              data-testid="history-load-more"
              href={historyHref({
                family: kind ? undefined : family,
                kind,
                class: doseClass,
                item: rawItem,
                media: mediaApplied,
                day,
                everyone,
                open: [...openFolds],
                expand: [...expanded].sort(),
                show: Math.min(show + HISTORY_SHOW_STEP, HISTORY_MAX_SHOW),
              })}
            >
              Load more
            </Link>
          ) : (
            <p
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="history-show-ceiling"
            >
              {`Showing the most recent ${HISTORY_MAX_SHOW} records.`}
            </p>
          )}
        </div>
      ) : null}

      {stops.length > 0 ? <JumpRailScrubber stops={stops} /> : null}
    </PageContainer>
  );
}
