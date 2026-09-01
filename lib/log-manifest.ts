// THE ONE LOGGING MANIFEST (issue #4425) — one domain-keyed declaration the TYPE
// SYSTEM enforces, replacing the eight separately-keyed censuses that each answered
// a corner of "what is domain X's logging story?" and each of which a new domain
// could be forgotten in independently.
//
// The audit that filed #4425 found exactly what that predicts: symptoms had no date
// bound at ALL while their four sibling domains each hand-declared one, and stool
// SHAPE-CHECKED its stated time where body metrics JUDGE theirs. Both are fixed as
// this file's first tenants.
//
// ── WINDOWS BIND OFFERS, NOT DOMAINS (owner ruling, 2026-08-31) ──────────────────
//
// Asked why domains bounded past writes at all, the answer was two reasons wearing
// five costumes: STALE-TAP protection (a one-tap must not resolve against a day its
// offer no longer describes — the dose ±2 IS Telegram pointer retention) and
// TEMPLATE-write honesty (the usual's 6-day reach plus its evidence guard). Neither
// is about the past itself, and the audited dose deep door already reached any day.
//
// So there is no per-domain window column here. There is ONE invariant every domain
// core holds — `isPastWriteAccepted`: any real past day, never the future — and a
// per-AFFORDANCE reach record for the taps and offers that genuinely are bounded. A
// DATED surface (the #4424 domain form with date context, `/history`'s day view)
// reaches any past day, audited where the domain audits; `logHistoricalDose` is the
// model. Mood's ±2 and practice's 30 survive as the reach of their tap surfaces.
//
// ── WHY A RECORD AND NOT A SCAN (owner ruling, #4458: types over guards) ─────────
//
//   • `Record<LogDomain, LogDomainManifest>` — adding a domain fails `tsc` until
//     every column is answered; adding a column fails `tsc` until every domain
//     answers it. There is no "did the census cover X" test to forget, because
//     there is no test.
//   • Every argued absence is a DISCRIMINATED UNION carrying its reason and its
//     issue, so `{ kind: "excluded" }` with nothing said does not compile. This is
//     `lib/loggable-domains.ts`'s `arguedExclusion` brand applied at the type level
//     rather than at the value level: the reason is required by the SHAPE, so a
//     reader always finds an argument where a row is absent.
//   • Nothing new joins the scan tier. `STATEFUL_WRITE_TABLES` keeps proving writes
//     route through cores — a call-site fact no type can see — and stays as it is.
//
// PURE AND DEPENDENCY-FREE: every import here is `import type`, fully erased at
// build, so a write core, a client component and the offline queue's pure core can
// all read this module. Nothing in it reads a clock or a database.

import type { LoggableDomain, ArguedExclusion } from "./loggable-domains";
import { arguedExclusion } from "./loggable-domains";
import { daysBetweenDateStr, isRealIsoDate } from "./date";
import type { QuickLogId } from "./quick-log";
import type { PaletteActionId } from "./palette-actions";
import type { TelegramVerb } from "./notifications/telegram-commands";
import type { HistoryLogKind } from "./history-format";
import type { FlowKind } from "./offline/queue";
import type { OneTapAffordance } from "./one-tap";
// The usual offer's reach is a SHIPPED constant, imported rather than restated so the
// declaration and the offer cannot drift. lib/food-regularity.ts is pure (date +
// food-slot only), so this keeps the module dependency-free.
import { USUAL_BACKFILL_WINDOW_DAYS } from "./food-regularity";

// ── The axis ─────────────────────────────────────────────────────────────────
//
// A LOG DOMAIN is a domain with a dated WRITE CORE — the grain at which a backfill
// window, a stated-time policy and a pair of client pieces are one answer. It is
// deliberately COARSER than `LoggableDomain` (lib/loggable-domains.ts), whose grain
// is "wherever a quick SURFACE distinguishes one": weight, vitals and temperature
// are three rows there because Telegram covers exactly one of them, and one `body`
// row here because they are one write contract with one window.
export const LOG_DOMAINS = [
  "food",
  "dose",
  "practice",
  "mood",
  "symptom",
  "stool",
  "substance",
  "body",
] as const;

export type LogDomain = (typeof LOG_DOMAINS)[number];

// The bridge between the two axes, so they cannot drift. Without it "adding a
// domain fails typecheck" would be true only of `LogDomain`, and a new
// `LoggableDomain` — the list a new quick surface actually gets added to — could
// still ship with no manifest entry, which is the gap class this issue exists to
// close. Three loggable domains are argued OFF this axis rather than missing.
export const LOG_DOMAIN_OF_LOGGABLE = {
  food: "food",
  dose: "dose",
  practice: "practice",
  mood: "mood",
  symptom: "symptom",
  stool: "stool",
  substance: "substance",
  weight: "body",
  vitals: "body",
  temperature: "body",
  activity: arguedExclusion(
    "A workout is a SESSION with a lifecycle and an editor (the #1428 decision rule), not a dated one-shot fact: it has a create-then-update persistence model, set arrays, and a live mode no log domain has. `ActivityForm` is already the shape #4424 rules for, so it needs no convergence leg and no window."
  ),
  period: arguedExclusion(
    "A cycle lifecycle transition, not a dated fact somebody logs (#1892): the affordance is ONE offer rendered from server state and its write core answers with typed refusals, so 'which days may this be written for' is a question about the open cycle rather than about a backfill window."
  ),
  document: arguedExclusion(
    "A file ingest. Its row is dated by the DOCUMENT — the day the lab drew the blood — not by the day anybody logged it (`LOG_DAY_SOURCES` argues the same point for the habit measure), so a backfill window around the profile's today would bound the wrong quantity."
  ),
} as const satisfies Record<LoggableDomain, LogDomain | ArguedExclusion>;

// ── The vocabulary every column shares ───────────────────────────────────────

// A tracker reference, as a template-literal type: `ref: "see the issue"` does not
// compile, so an argument always carries somewhere to read the rest of it.
export type IssueRef = `#${number}`;

// "Covered, and here is by what" / "absent, and here is the argument". The generic
// is the EVIDENCE — a real id union wherever one exists, so a row naming a retired
// sheet entry, palette action, Telegram verb, history kind or offline flow fails
// `tsc` exactly as the censuses this replaces did.
export type Declared<Via> =
  | { readonly kind: "covered"; readonly via: Via }
  | {
      readonly kind: "excluded";
      readonly reason: string;
      readonly ref: IssueRef;
    };

// How far a TAP or an OFFER reaches. Not a domain property — the same domain is
// reachable from a bounded tap and from a dated form, and only the tap is bounded.
//
//   today   — the affordance states no day at all; its action stamps the profile's
//             today, so there is no reach to bound.
//   dated   — the surface carries a date and the tap writes to it. Any real past day,
//             bounded only by the shared core invariant below.
//   bounded — a real window, with the argument for its size required by the type.
//             This is where the five hand-declared "domain windows" actually lived.
export type TapReach =
  | { readonly kind: "today" }
  | { readonly kind: "dated" }
  | {
      readonly kind: "bounded";
      readonly back: number;
      readonly forward: number;
      readonly reason: string;
      readonly ref: IssueRef;
    };

// What the domain does with a time somebody STATES ("Happened earlier?", a
// backfilled reading's clock). `judged` runs the one acceptance gate
// (`judgeStatedAt`, lib/stated-time.ts) and reports its refusal; `none` means the
// row has no instant column to state into, argued so the absence is a decision.
export type StatedTimePolicy =
  | { readonly kind: "judged"; readonly seam: "judgeStatedAt" | "dose-guards" }
  | {
      readonly kind: "none";
      readonly reason: string;
      readonly ref: IssueRef;
    };

// ── WHAT A CORE DECLARES BESIDE ITSELF (#4614) ───────────────────────────────
//
// The manifest used to NAME its cores, and that column alone had a type floor with no
// completeness check — three rows went stale inside a day, one of them wrong at birth.
// The direction is inverted here: each core declares its own domain beside its
// definition and the column DERIVES, so drift by addition is a missing declaration
// where the door is written rather than an omission in a file nobody opened, and a
// rename or a delete takes the declaration with it.
//
// The stated-time answer rides on the same declaration (#4568 ruling 1) — it is a
// per-CORE property, `TAP_REACH`'s axis lesson applied to the column body's six cores
// disagreed on — so a declaration cannot be made without answering it.
export interface LogCoreDeclaration<D extends LogDomain = LogDomain> {
  readonly domain: D;
  readonly statedTime: StatedTimePolicy;
}

function declaresLogCore<D extends LogDomain>(
  domain: D,
  statedTime: StatedTimePolicy
): LogCoreDeclaration<D> {
  return { domain, statedTime };
}

// One declaration per (domain, stated-time answer) pair. A core writes
// `export const <name>Declares = <one of these>;` beside its definition; the suffix is
// what the derivation at the foot of this file reads. Naming them here keeps each
// argument in ONE place — five practice cores share a reason rather than restating it.

// An UNDO takes back the row its own tap wrote and carries no instant, while the LOG
// door beside it judges one. That is the disagreement a domain-grain cell could not
// hold, in the smallest case there is.
const UNDO_STATES_NOTHING = {
  kind: "none",
  reason:
    "An undo names the row its own tap created and takes no time: the instant it removes was judged when the tap wrote it, so there is no second statement to judge.",
  ref: "#4568",
} as const satisfies StatedTimePolicy;

const JUDGED = {
  kind: "judged",
  seam: "judgeStatedAt",
} as const satisfies StatedTimePolicy;

export const FOOD_SERVING_LOG = declaresLogCore("food", JUDGED);
export const FOOD_SERVING_UNDO = declaresLogCore("food", UNDO_STATES_NOTHING);

export const DOSE_RESOLUTION = declaresLogCore("dose", {
  kind: "judged",
  seam: "dose-guards",
});
export const DOSE_CONFIRM_UNDO = declaresLogCore("dose", UNDO_STATES_NOTHING);

// WRONG, AND THE TYPE STILL CANNOT SAY SO — flagged rather than asserted (#3143
// review). `none` means "no instant column to state into", and both halves are false
// for the cores that take a statement: `practice_logs` carries `start_time`/`end_time`
// (#3142) and the quick sheet's "Happened earlier?" states an END. The truthful value
// would be `judged`, which the type requires a shared seam for, and practice checks its
// stated end inline. So `none` stays because it is the only representable value, not
// because it is the answer. Settle it by routing the stated end through the seam, or by
// giving the union an arm for a domain that judges its own; both are rulings, not edits.
export const PRACTICE_SESSION_LOG = declaresLogCore("practice", {
  kind: "none",
  reason:
    "STALE — see the comment above. The original argument ('a time field here would collect a statement with nowhere to be stored') was true when written and is false now; the column exists, every tap writes it, and the sheet collects a stated end.",
  ref: "#3143",
});

// The live pair is the half of practice the cell above was never true of, and the
// re-key per core is what let it say so: neither start nor end takes a stated time.
export const PRACTICE_LIVE_TAP = declaresLogCore("practice", {
  kind: "none",
  reason:
    "A live session's start and end are the taps themselves (#3142): each stamps the profile-local minute at the moment it is pressed and neither accepts a time, so nothing is stated.",
  ref: "#3142",
});

export const MOOD_CHECKIN = declaresLogCore("mood", {
  kind: "none",
  reason:
    "A check-in is a DAY's answer (#992/#2312, answered rather than left to inference): `MoodPayload` carries no instant, the queue's captured date is the whole of its time model, and a replay at dinner still lands on the day the user tapped.",
  ref: "#992",
});

export const SYMPTOM_DAY_WRITE = declaresLogCore("symptom", {
  kind: "none",
  reason:
    "A symptom-day is ONE row, UNIQUE(profile_id, date, symptom), keeping the day's WORST severity: the table has no instant column and a second tap settles onto the same row rather than becoming a second observation. The temperature reading the bar can also take is the `body` domain's, and it states its own time there.",
  ref: "#799",
});

export const STOOL_MOVEMENT_LOG = declaresLogCore("stool", JUDGED);

export const SUBSTANCE_USE_WRITE = declaresLogCore("substance", {
  kind: "none",
  reason:
    "`substance_daily_totals` is a DAY TOTAL. It has a `recorded_at` — when the use was filed — and no event instant at all, which is why the record renders these rows date-only and sinks them below the day's timed ones.",
  ref: "#3327",
});

// TRUE OF ALL SIX BODY CORES SINCE #4568, and it was true of five: both temperature
// doors resolved through a file-private `normalizeClockTime` — a SHAPE check — so the
// old domain-grain cell asserted something false about one of them. They run
// `resolveStatedOccurredAt` now. What a refusal COSTS still differs by door (log keeps
// the reading, correction refuses the submission), which is lib/stated-time.ts's rule
// and not a second policy.
export const BODY_READING_WRITE = declaresLogCore("body", JUDGED);

// #4424 ruling 7: exactly two shared client pieces per domain — one FORM (add and
// full-statement edit) and one ROW CONTROL (taps and micro-corrections). Naming
// them here is what makes each domain leg's definition of done a COMPILE ERROR
// rather than a reviewer's judgement: the leg flips `unconverged` to `shared`.
export type ClientPiece =
  | { readonly kind: "shared"; readonly component: string }
  | {
      readonly kind: "unconverged";
      readonly reason: string;
      readonly ref: IssueRef;
    };

// #3275 closed by absorption (2026-08-31): its offline-story column landed here and
// its failure-channel + commit-verb CONVENTIONS landed on #3276, which owns them
// verbatim — inline `role="alert"` plus toast for anything with fields, "Mark taken" /
// "Log now" for action rows, "Save" for forms. The clause that came HERE is the last
// one: a domain that DIVERGES argues it in its manifest entry. So this column carries
// divergences only; `convention` means none is recorded, never that #3276's audit ran.
export type WriteConventions =
  | { readonly kind: "convention" }
  | {
      readonly kind: "diverges";
      readonly what: string;
      readonly reason: string;
      readonly ref: IssueRef;
    };

export interface LogDomainManifest {
  // The domain's offline story. `flow` is the queue's primary capture; `alsoFlows`
  // names the others a domain rides, so `lib/offline/queue.ts` can derive its
  // domain-grain rows from here instead of restating them.
  readonly offline:
    | {
        readonly kind: "covered";
        readonly flow: FlowKind;
        readonly alsoFlows?: readonly FlowKind[];
      }
    | {
        readonly kind: "excluded";
        readonly reason: string;
        readonly ref: IssueRef;
      };
  // The four surfaces a person can reach the domain through. The sheet SEGMENT is
  // deliberately not a fifth column — it is `LOG_SEGMENT_CENSUS[sheet.via]`, so
  // there is one grouping in the tree and this cannot disagree with it.
  readonly surfaces: {
    readonly sheet: Declared<QuickLogId>;
    readonly palette: Declared<readonly PaletteActionId[]>;
    readonly telegram: Declared<readonly TelegramVerb[]>;
    readonly history: Declared<HistoryLogKind>;
  };
  readonly pieces: {
    readonly form: ClientPiece;
    readonly rowControl: ClientPiece;
  };
  readonly writeConventions: WriteConventions;
  // No `cores` column: the cores DECLARE and `LogCoresOf` derives (see below).
}

// ── THE MANIFEST ─────────────────────────────────────────────────────────────

export const LOG_MANIFEST = {
  food: {
    offline: { kind: "covered", flow: "food" },
    surfaces: {
      sheet: { kind: "covered", via: "log-food" },
      palette: { kind: "covered", via: ["log-food"] },
      telegram: { kind: "covered", via: ["food"] },
      history: { kind: "covered", via: "food" },
    },
    pieces: {
      form: {
        kind: "unconverged",
        reason:
          "`FoodLogBar` is the sheet's form and the `/history` door re-spells its own; #3987 is rebuilding the nutrition page into Day | Manage and DEFINES what food's form and rows are, so this row flips on that leg rather than forking a copy mid-rebuild.",
        ref: "#3987",
      },
      rowControl: {
        kind: "unconverged",
        reason:
          "The Day ledger's row writes and the `/history` food rows are two spellings; #4316's shared row shape is the extraction both compose, and it sits in nutrition's path.",
        ref: "#3987",
      },
    },
    writeConventions: { kind: "convention" },
  },

  dose: {
    offline: { kind: "covered", flow: "dose", alsoFlows: ["skip-dose"] },
    surfaces: {
      sheet: { kind: "covered", via: "log-dose" },
      palette: { kind: "covered", via: ["log-dose"] },
      telegram: { kind: "covered", via: ["dose"] },
      history: { kind: "covered", via: "dose" },
    },
    pieces: {
      // #4424's dose leg. `HistoricalDoseForm` is add AND full-statement edit at every
      // mount — the record's door, that record row's correction, the Supplements card,
      // and the per-item dose history's add and ⋯.
      //
      // THE FORM CLAIM WAS RIGHT ABOUT THE COMPLAINT AND WRONG ABOUT THE FACT. It said
      // the `/history` door "routes doses to the legacy `DoseBackfillLauncher`, so the
      // domain does not yet have ONE form every surface mounts" — but that launcher
      // MOUNTED this form, as did every other dose door. What was spelled twice was the
      // ITEM PICKER in front of it (`DoseBackfillLauncher`, `HistoricalDoseLauncher`),
      // each building the dose options its own way; the form owns it now and the
      // launcher is deleted. And the door had NO DAY: every other kind opens on the day
      // being read (#4045 §1) and the dose branch bypassed `HistoryAddDoor` to open on
      // today.
      //
      // `DoseStatusControl` is the control every dose row hosting a write control
      // mounts. THE CELL WAS RIGHT that the ledger "picks between two controls per row
      // by `isToday`" and that `QuickDoseList` straddles two writes; the reason was one
      // line — `setDoseStatus` stamped `today(profileId)`, so the tri-state could not
      // name yesterday and each surface hand-rolled a dated pair. The ledger's own
      // comment blamed the CORE ("the tri-state's CLEAR has no dated core"): wrong —
      // `setDoseStatusCore` gates on `isDoseDateAccepted`, the same ±2, and always did.
      // The action takes a day bounded by `doseLogDays` now, so a past day gained the
      // CLEAR it never had and three spellings are deleted.
      //
      // WHAT #4316 ACTUALLY LANDED, since this cell named it as the blocker: `a6aa7867`
      // extracted `useDoseDayResolution` — a shared WRITE OWNER, not a row component —
      // and both surfaces went on drawing their own buttons. Its single-row arm goes
      // with this leg; what stays shared is the whole-stack "Take all", which is
      // `dose-day-stack`, a bulk offer and not a row control.
      //
      // `DoseConfirmButton` STANDS, AND IS NOT A SECOND ROW CONTROL. Its two mounts —
      // the dashboard attention row, the household card's due row — list what is still
      // OWED, so the row is unmounted by its own write: the tri-state's receipt (#2654)
      // cannot exist there and the answer has to be a toast carrying the inverse
      // (#2642). One component, two gates, which the issue body names as the
      // requirement. Folding it in would delete a documented undo with no ruling.
      form: { kind: "shared", component: "HistoricalDoseForm" },
      rowControl: { kind: "shared", component: "DoseStatusControl" },
    },
    writeConventions: { kind: "convention" },
  },

  practice: {
    offline: { kind: "covered", flow: "practice" },
    surfaces: {
      sheet: { kind: "covered", via: "log-practice" },
      palette: { kind: "covered", via: ["wellness-practices"] },
      telegram: { kind: "covered", via: ["practice"] },
      history: { kind: "covered", via: "practice" },
    },
    pieces: {
      // #4424's practice leg. `PracticeSessionForm` is add AND full-statement edit at
      // every mount — the Wellness card's modal, the backfill launcher, the record's
      // door, that record row's correction and the session history's ⋯.
      //
      // THIS CELL SAID THE FIELD SETS WERE "NO LONGER THREE" AND THAT THE FLIP WAS
      // BLOCKED ON A SECOND WRITE CORE. Both were re-derived and both were wrong. #3143
      // did extract one expanded form and give it two mounts, but FOUR hand-rolled
      // spellings of the practice statement were live when this leg opened: that form,
      // this history's own edit form (the same five fields again), the `/history`
      // door's, and that record row's correction — the last two carrying four of the
      // five, with no END, so a window stated in the expanded form was correctable on
      // exactly one surface. And
      // `logUpcomingPractice` was never a core — it reached `logPracticeSession`
      // through `logPracticeByTargetId`, the resolver Telegram's Done shares — so
      // ruling 7 deleted a DOOR, and the `cores` column below was already correct.
      // The defects the cell named were all real: no duration, no confirm, its own
      // gate, its own result shape.
      //
      // `LogPracticeButton` is the row control every practice row hosting a write
      // control mounts: the Wellness card, the dashboard protocol rows, the quick
      // sheet's rows and — since this leg — Upcoming's, which fronted its own button
      // and its own action. That row gains the duration stepper, the same-day re-log
      // confirm and the live lifecycle by mounting the shared one rather than by
      // having them re-added to a copy.
      //
      // UPCOMING'S ROW DROPS ITS `stale-target` REFUSAL, deliberately (owner ruling,
      // 2026-09-01, so nobody reads the loss as an oversight). The deleted door posted a
      // target id and could refuse when that target had gone; the control posts a NAME.
      // Practice logs are name-keyed and outlive their target, so that refusal guarded a
      // stale POINTER — and this leg leaves no pointer to be stale. See `practiceItems`
      // for why the row resolves rather than the control (lib/queries/upcoming/plans.ts).
      //
      // ON `/history` THE FEED ROW MOUNTS THE FORM AND NOT THE CONTROL, and that is
      // ruling 3 itself rather than a gap — the precedent recorded on #4424 after the
      // symptom leg: #3958 makes that row one line at every viewport with its trailing
      // affordance EXCLUSIVE, so a full-statement edit behind the ⋯ is what ruling 3
      // asks for there. `shared` means the domain has exactly ONE implementation and
      // every row hosting a write control mounts it; mount count is not the test.
      form: { kind: "shared", component: "PracticeSessionForm" },
      rowControl: { kind: "shared", component: "LogPracticeButton" },
    },
    writeConventions: { kind: "convention" },
  },

  mood: {
    offline: { kind: "covered", flow: "mood" },
    surfaces: {
      sheet: { kind: "covered", via: "log-mood" },
      palette: { kind: "covered", via: ["log-mood"] },
      telegram: { kind: "covered", via: ["mood"] },
      history: { kind: "covered", via: "mood" },
    },
    pieces: {
      // THE FORM CELL'S COUNT WAS STALE IN BOTH DIRECTIONS (#4427). The optional
      // Energy/Calm/factors/note fields had ZERO current logging mounts: the retired
      // dashboard card once drew them, while `QuickMoodCheckin` only carried stored
      // values through its one-tap payload. `SleepMoodEditDialog` likewise corrected
      // valence while preserving the hidden remainder. `MoodForm` owns the complete
      // statement now and is mounted by quick entry and the record's add/edit doors.
      //
      // THE ROW-CONTROL CELL WAS ALSO STALE. The dashboard faces it cited retired
      // with the dashboard becoming a door; metric-detail mood rows already mounted
      // `ReadingValueControl`, inherited from body exactly as body's cell promised.
      // The record keeps the feed-row precedent from #3958: its exclusive ⋯ opens the
      // shared full form, with no third inline control.
      form: { kind: "shared", component: "MoodForm" },
      rowControl: { kind: "shared", component: "ReadingValueControl" },
    },
    writeConventions: { kind: "convention" },
  },

  symptom: {
    // THE FIRST TENANT (#4425). Until this entry symptoms had no date bound at all:
    // `parseDate` in app/(app)/symptom-actions.ts regex-matched `\d{4}-\d{2}-\d{2}`
    // without `isRealIsoDate` — so `2026-13-45` reached the core as a literal string
    // — and `logSymptomCore` bounded nothing. Matching mood is the ruling, and mood
    // is the honest sibling: a subjective daily self-report, backfilled a day or two
    // late, correctable afterwards from the row rather than re-logged.
    offline: {
      kind: "excluded",
      reason:
        "Deferred to #1860, which owns the symptom quick-log's offline story. Deciding it here would preempt that issue's scope, and the affordance census (`OFFLINE_QUEUE_COVERAGE`) has excluded `symptom-severity` by name on this reasoning since #2130.",
      ref: "#1860",
    },
    surfaces: {
      sheet: { kind: "covered", via: "log-symptom" },
      palette: { kind: "covered", via: ["log-symptom"] },
      telegram: { kind: "covered", via: ["symptom"] },
      history: { kind: "covered", via: "symptom" },
    },
    pieces: {
      // #4424's symptom leg. `SymptomForm` is add AND full-statement edit — the record's
      // symptom door and that row's correction — with the day riding in from the mount,
      // because the store is UNIQUE(profile_id, date, symptom) and a date FIELD would
      // let a correction merge two days' worst severities into one.
      //
      // `SymptomRowControl` is everything a logged day can be corrected with WITHOUT
      // restating it: the severity taps (a plain tap RAISES, a labelled chip below the
      // current value posts the narrow lower), the note, and the clear with its undo.
      //
      // ON `/history` THE FEED ROW MOUNTS THE FORM AND NOT THE CONTROL, and that is
      // ruling 3 itself rather than a gap: a full-statement edit opens the form in edit
      // mode, which is what the ⋯ does. The feed row hosts no one-field inline edit
      // because #3958 leaves it nowhere to go — that ruling makes the row one line at
      // every viewport with the trailing affordance EXCLUSIVE (⋯ or ›, never both), and
      // #4424 nowhere claims to override it. The day view's own card mounts the bar,
      // whose rows are this control.
      //
      // THE CONTROL HAS ONE MOUNT TODAY — the bar — so read `shared` as "the domain has
      // exactly one, and every symptom row hosting a write control mounts it", never as
      // "mounted twice". The cell's complaint was that row-control-grade behaviour LIVED
      // INSIDE the bar, and extracting it is the fix whether or not a second surface
      // exists yet. A second one appears the day #4076's control slot reaches this
      // domain, and it will not have to re-decide the raise/lower routing or the undo.
      form: { kind: "shared", component: "SymptomForm" },
      rowControl: { kind: "shared", component: "SymptomRowControl" },
    },
    writeConventions: { kind: "convention" },
  },

  stool: {
    // THE SECOND TENANT (#4425). Until this entry `logBristolStool` ran only
    // `normalizeClockTime` — a SHAPE check — so "Happened earlier?" accepted 23:50
    // typed at 09:00, filing a bowel movement fourteen hours in the future on a row
    // whose natural key IS its instant.
    offline: { kind: "covered", flow: "stool" },
    surfaces: {
      sheet: { kind: "covered", via: "log-stool" },
      palette: {
        kind: "excluded",
        reason:
          "The palette is a keyboard surface for a desk; a stool log is a phone-in-hand moment and its whole affordance is the seven icons over the published scale, which a text-matched command row cannot carry. Nothing in the palette would be faster than the sheet row.",
        ref: "#2785",
      },
      telegram: {
        kind: "excluded",
        reason:
          "Sensitive by DELIVERY rather than by content: a chat message naming a bowel movement can surface on a lock screen or a shared device — the same reach-policy argument that keeps substance off this vocabulary — and a one-line `/stool 6` would drop the descriptions people actually pick against.",
        ref: "#2785",
      },
      history: {
        kind: "excluded",
        reason:
          "`HISTORY_LOG_KINDS` has no stool row, so a logged movement is visible on Trends and nowhere correctable. This is the missing-leg class rather than a decision against.",
        ref: "#4433",
      },
    },
    pieces: {
      form: {
        kind: "unconverged",
        reason:
          "The seven-button picker in the quick-entry overlay is the only write mount; there is no form to open in edit mode because there is no correction path at all.",
        ref: "#4433",
      },
      rowControl: {
        kind: "unconverged",
        reason:
          "No surface renders a stool ROW with an action — the Trends dot strip is a read — so the row control has nowhere to mount yet.",
        ref: "#4433",
      },
    },
    writeConventions: {
      kind: "diverges",
      what: "Failure is TOAST-ONLY on a surface that has a field: the picker's \"Happened earlier?\" fold collects a stated time, and #3276's convention is that anything with fields answers inline as well.",
      reason:
        "The seven icons are the affordance and the fold is optional, so the row was built as a tap row and kept a tap row's channel when the field arrived (#3273). Recorded rather than fixed here: the refusal this issue teaches it to report rides the same toast, and moving the channel is #3276's pipeline work, not a window fix.",
      ref: "#3276",
    },
  },

  substance: {
    offline: {
      kind: "excluded",
      reason:
        "The tap's own feedback is server-derived: the card renders the week count and the #998 cap verdict beside the button, and a queued unit would leave that safety readout silently understating until replay. NARROWED, NOT OVERTURNED (#3279) — the argument presumes a cap EXISTS, and a profile with no reduction cap has no verdict to understate — but the exclusion stays absolute until that split is built.",
      ref: "#3279",
    },
    surfaces: {
      sheet: { kind: "covered", via: "log-substance" },
      palette: {
        kind: "excluded",
        reason:
          "A deliberate-access medical surface whose tap must render beside its #998 cap verdict; off general-purpose quick surfaces by reach policy, the same call the Telegram vocabulary makes.",
        ref: "#3279",
      },
      telegram: {
        kind: "excluded",
        reason:
          "Deliberate-access, sensitive domain: chat delivery can surface on lock screens and shared devices, and the tap must stand beside its cap verdict. Off the chat vocabulary by reach policy.",
        ref: "#998",
      },
      history: { kind: "covered", via: "substance" },
    },
    pieces: {
      // #4424's substance leg. `SubstanceForm` is add AND full-statement edit at every
      // mount, with the unit-labelled amount (#4211); `SubstanceUnitControl` carries the
      // tap, its undo, and the cap verdict the exclusion above is argued from.
      form: { kind: "shared", component: "SubstanceForm" },
      rowControl: { kind: "shared", component: "SubstanceUnitControl" },
    },
    writeConventions: { kind: "convention" },
  },

  body: {
    offline: {
      kind: "covered",
      flow: "body-metric",
      alsoFlows: ["vitals"],
    },
    surfaces: {
      sheet: { kind: "covered", via: "log-measurements" },
      palette: { kind: "covered", via: ["log-weight", "log-vitals"] },
      // Weight and temperature have verbs; the vitals SITTING does not, and the
      // finer-grained argument for that lives where the grain does
      // (`TELEGRAM_DOMAIN_CENSUS`: a BP pair is a form, not a one-line capture).
      telegram: { kind: "covered", via: ["weight", "temp"] },
      history: { kind: "covered", via: "body" },
    },
    pieces: {
      // #4424's body leg. `MeasurementsQuickAdd` is the form at every mount — the
      // Trends panel, a metric detail page, the quick-log sheet and the record's add
      // door — and `measurementsQuickEntry` is the ONE reader that answers what it
      // needs on a given day, so a mount SPREADS that shape rather than listing seven
      // props and quietly listing six.
      //
      // THE PEDIATRIC LABEL LOOKUP COMPOSES THE FIELD, NOT THE FORM, and that is ruling
      // 2's own wording rather than a shortfall: it renders inside `IntakeItemForm`'s
      // `<form>`, so a component drawing its own would be a nested one and its Save
      // would be inert. It mounts `WeightField` — the `TemperatureField` precedent,
      // ruling 5 — and posts `addMeasurements` like every other body door.
      //
      // ADD AND EDIT ARE ONE LAYOUT AND ALSO ONE ACTION here, which is stronger than
      // ruling 1 asks for: `insertBodyMetric` is find-then-write per day, so a sitting
      // resubmitted on a day that already has a row CORRECTS it. Edit mode is therefore
      // the seed — `defaultStatedAt` off that day's own `occurred_at` — and nothing
      // else. A reading's one-field correction is the row control below.
      //
      // THE CELL'S FIGURES DID NOT SURVIVE MEASUREMENT and are corrected here rather
      // than inherited. The form defines NINETEEN fields (eighteen plus Notes) and
      // renders SEVENTEEN at either life stage, not thirteen; the stale number traces
      // to a comment in the form itself, written before #1850, #1851 and #2322 added
      // seven more, and is fixed at that source too. `PediatricWeightUpdate` was the
      // THIRD weight form, not the fourth: the count reached four by including the
      // one-field row edit, which ruling 3 classes as row-control-grade and which edits
      // any metric's value rather than a weight. The door's three measures,
      // `PediatricWeightUpdate`'s hand-drawn weight input and `addBodyMetric` — a fourth
      // body write action carrying a strict subset of `addMeasurements` — are all
      // deleted, and the palette posts the measurements action.
      //
      // THE ROW CONTROL HAD THREE IMPLEMENTATIONS, not the one the cell named: the
      // readings-table cell, `/history`'s `case "body"` correction form, and
      // `BodyMetricRowMenu`'s modal — all three posting `updateMetricReading` with the
      // same three fields. All three mount `ReadingValueControl` now, and it is the only
      // thing in the tree that imports that action.
      //
      // MOOD'S LEG INHERITS THAT CONTROL RATHER THAN EXTRACTING A SECOND ONE (#4427).
      // `/trends/metric/<slug>` charts mood and sleep beside the body measures, so a
      // mood reading's value is corrected through this same component —
      // `updateMetricRow` routes the mood store underneath it. Named here so that leg
      // reads it as an inheritance in its own cell instead of finding a body-named
      // control on its rows and drawing a fourth.
      //
      // THE DASHBOARD IS NOT A GAP. Its body rows are readouts with an `href`; the one
      // body write control there is the setup-tier Vitals row's
      // `DashboardQuickEntryAction`, which OPENS the form in the sheet and is ruling 2's
      // mount rather than a second row control. So read `shared` as the symptom leg
      // established it: the domain has exactly one control and every body row hosting a
      // write control mounts it. Mount count is not the test.
      form: { kind: "shared", component: "MeasurementsQuickAdd" },
      rowControl: { kind: "shared", component: "ReadingValueControl" },
    },
    writeConventions: { kind: "convention" },
  },
} as const satisfies Record<LogDomain, LogDomainManifest>;

// ── THE DERIVED CORES COLUMN (#4614) ─────────────────────────────────────────
//
// Every module that defines a log core. TYPE-ONLY, and `typeof import(...)` rather
// than an import statement, so this file stays as pure and dependency-free as its
// header promises — a client component reading `LOG_MANIFEST` pulls in no `db`.
//
// THE SUBMISSION CORE, NOT THE STORAGE LAYER BENEATH IT (#4425 review): `body` named
// `recordReading`, which nothing but `insertVitals` calls, and so missed the five cores
// a body submission posts through. The test for a declaration is that a SURFACE calls
// the function; corrections and deletes carry none, matching what the rows named.
type LogCoreModules =
  | typeof import("./food-log-write")
  | typeof import("./queries/intake/adherence")
  | typeof import("./practice-log")
  | typeof import("./offline/writes")
  | typeof import("./symptom-log-write")
  | typeof import("./substance-log-write")
  | typeof import("./substance-daily-totals-write")
  | typeof import("./temperature-log");

// Read every `<coreName>Declares` export whose declaration names domain `D`.
// Distributive so the module union is walked one module at a time.
type DeclaredCoresIn<M, D extends LogDomain> = M extends unknown
  ? {
      [K in keyof M]: K extends `${infer Core}Declares`
        ? M[K] extends LogCoreDeclaration<D>
          ? Core
          : never
        : never;
    }[keyof M]
  : never;

// The manifest's cores column, derived. `LogCoresOf<"practice">` is what the practice
// row used to spell out by hand.
export type LogCoresOf<D extends LogDomain> = DeclaredCoresIn<
  LogCoreModules,
  D
>;

// Every core in the app, as a union — so a renamed or deleted core stops being one.
export type LogCoreName = LogCoresOf<LogDomain>;

// COMPLETENESS, THE HALF THE OLD COLUMN NEVER HAD: a domain whose cores all lost their
// declarations — or a new `LogDomain` whose doors never wrote one — derives an empty
// list, and this assignment stops compiling.
type DomainsThatDeclareACore = {
  [D in LogDomain]: [LogCoresOf<D>] extends [never] ? never : D;
}[LogDomain];

export const EVERY_DOMAIN_DECLARES_A_CORE: LogDomain extends DomainsThatDeclareACore
  ? true
  : never = true;

// ── The shared invariant every domain core holds ─────────────────────────────

// Is `date` a day a domain core may write? ANY REAL PAST DAY, NEVER THE FUTURE —
// the whole rule, for every domain, per the owner ruling above. Pure: `todayStr` is
// the caller's already-resolved profile today, so this stays clock-free and the
// profile-local day is the caller's to establish.
//
// `isRealIsoDate` FIRST, and it is load-bearing rather than defensive: `Date.parse`
// silently ROLLS `2026-02-30` forward to March 2, so a day-difference comparison
// answers for a day the calendar does not have. Two shipped predicates
// (`isDoseDateAccepted`, `isMoodDateAccepted`) accepted exactly that until this
// change; only the practice one had noticed. The ruling opens the PAST half and
// leaves that class dead, deliberately.
//
// The comparison is a string compare, which is the shipped idiom for this question
// (`logFoodServingCore`'s `date > today(profileId)`) and is exact on zero-padded
// ISO days once `isRealIsoDate` has established the shape.
export function isPastWriteAccepted(todayStr: string, date: string): boolean {
  return isRealIsoDate(date) && date <= todayStr;
}

// ── What the bounded taps and offers actually reach ──────────────────────────
//
// Keyed on `OneTapAffordance`, which is the axis these bounds were always on — the
// same axis finding that keeps `OFFLINE_QUEUE_COVERAGE`'s rows local: a domain is
// reachable from a bounded tap AND from a dated form, so a domain-grain column
// cannot hold this without saying something false about one of them.
//
// A new affordance fails `tsc` here until someone says how far it reaches, and a
// `bounded` reach cannot be declared without the argument for its size.
export const TAP_REACH = {
  // The nutrition bar and the `/history` door both stand on a day and post it.
  "food-serving": { kind: "dated" },
  "protein-grams": { kind: "dated" },
  "food-usual": {
    kind: "bounded",
    back: USUAL_BACKFILL_WINDOW_DAYS,
    forward: 0,
    reason:
      "TEMPLATE-WRITE HONESTY, not a backfill limit (#4118). The offer is the habitual set MINUS what the window already holds, re-derived by the write core, and it is only offered for a day whose evidence still supports it — so the reach is how far back the habit claim stays true, and the evidence guard is the other half of the same bound.",
    ref: "#4118",
  },
  "routine-usual": {
    kind: "bounded",
    back: USUAL_BACKFILL_WINDOW_DAYS,
    forward: 0,
    reason:
      "The composed bundle rides `food-usual`'s reach and adds its dose half, which confirms doses and moves an on-hand supply ledger — so an expired replay would be stock arithmetic against a total that moved, not a capture.",
    ref: "#2458",
  },
  // The one-tap dose resolutions. THE ±2 IS TELEGRAM POINTER RETENTION, which is
  // what the ruling means by an offer bound: since #2018 a dose keyboard stays live
  // for exactly this window and the reconcile sweep can only close it while its
  // pointer still exists, so raising this past retention would strand live keyboards
  // with nothing left to close them. The two move together, window < retention.
  "dose-status": {
    kind: "bounded",
    back: 2,
    forward: 2,
    reason:
      "Coupled to `MESSAGE_POINTER_RETENTION_DAYS` (lib/notifications/message-pointers.ts, currently 3): a Telegram dose keyboard stays live for exactly this window, so the tap must stay resolvable for as long as the message it sits on can be tapped. Symmetric because a late after-midnight tap must still land on the reminder's own day.",
    ref: "#614",
  },
  "dose-day": {
    kind: "bounded",
    back: 2,
    forward: 2,
    reason:
      "A single dated dose tap — the day switcher's, and since #4424's dose leg the day ledger's row on any day but today. It IS the tri-state on a stated day (`DoseStatusControl` posts `setDoseStatus` with the row's date), so it inherits the pointer-retention bound rather than declaring one: `doseLogDays` offers exactly the past half of this reach, off this constant, and the action checks the posted day against that same list.",
    ref: "#3936",
  },
  "dose-day-stack": {
    kind: "bounded",
    back: 2,
    forward: 2,
    reason:
      "The same switcher's per-bucket bulk row (#3936) writing through the same scheduled cores, so the same bound; its own online-only argument is about supply arithmetic and lives in `OFFLINE_QUEUE_COVERAGE`.",
    ref: "#3936",
  },
  // The audited deep door, and the ruling's named model for what a DATED surface is.
  "dose-backfill": { kind: "dated" },
  "mood-valence": {
    kind: "bounded",
    back: 2,
    forward: 0,
    reason:
      "The reach of the day CHIPS — Today, Yesterday, and the day before (#2128) — which is all this tap can state. Past-only because a check-in cannot be pre-logged. The core takes any past day like every other; a dated mood form (#4427) would reach further without touching this.",
    ref: "#2128",
  },
  "practice-session": {
    kind: "bounded",
    back: 30,
    forward: 0,
    reason:
      "The reach of the wellness page's log launcher, whose `minDate` is this many days back: a reader reconciling a month of sittings is the ordinary case. Past-only at the offer even though the retired core bound was symmetric — the launcher never offered a future day.",
    ref: "#2908",
  },
  // The symptom bar is mounted on dated surfaces — `/history`'s day view passes the
  // day being read — so its taps are dated writes. This row is the ruling's answer
  // to this lane's blocker, declared rather than left implicit.
  "symptom-severity": { kind: "dated" },
  // Taps whose action stamps the profile's today and offer no day to state.
  "substance-unit": { kind: "today" },
  "prn-dose": { kind: "today" },
  "mobility-move": { kind: "today" },
  "period-lifecycle": { kind: "today" },
  "stool-form": { kind: "today" },
  "medication-refill": { kind: "today" },
} as const satisfies Record<OneTapAffordance, TapReach>;

// Is `date` inside `id`'s declared reach, given the profile's already-resolved today?
// The offer-side twin of `isPastWriteAccepted`, and the ONE realization of every tap
// bound: `isDoseDateAccepted` and `isMoodDateAccepted` are this function wearing their
// names, and the practice queue consults it to decide that a capture has aged out.
//
// A `today` tap accepts only today; a `dated` surface accepts what any core would.
export function isWithinTapReach(
  id: OneTapAffordance,
  todayStr: string,
  date: string
): boolean {
  if (!isRealIsoDate(date)) return false;
  const reach = TAP_REACH[id];
  if (reach.kind === "dated") return isPastWriteAccepted(todayStr, date);
  if (reach.kind === "today") return date === todayStr;
  const diff = daysBetweenDateStr(todayStr, date);
  if (diff == null) return false;
  return diff <= reach.forward && -diff <= reach.back;
}
