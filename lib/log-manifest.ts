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

// How far a domain's dated write core reaches, in profile-LOCAL days either side of
// the profile's today. `"unbounded"` is a real answer, not a gap — the `/history`
// door's arbitrary past is deliberate for the ledger domains — and it is spelled
// out so a reader can tell it from a domain nobody bounded.
export type DayReach = number | "unbounded";

// The window, with the oddity arm carrying its argument. `ordinary` means the size
// speaks for itself; anything a reader would ask "why that number?" about takes
// `argued` and answers in place. Doses' ±2 is the reason this arm exists: it is
// COUPLED to `MESSAGE_POINTER_RETENTION_DAYS`, and flattening it to a bare 2 would
// lose the constraint that keeps the two moving together.
export type BackfillWindow = {
  readonly back: DayReach;
  readonly forward: DayReach;
} & (
  | { readonly kind: "ordinary" }
  | { readonly kind: "argued"; readonly reason: string; readonly ref: IssueRef }
);

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
  readonly window: BackfillWindow;
  readonly statedTime: StatedTimePolicy;
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
  // The dated write cores this domain's every surface must post through — the list
  // the `STATEFUL_WRITE_TABLES` scan's call-site rule is about.
  readonly cores: readonly [string, ...string[]];
}

// ── THE MANIFEST ─────────────────────────────────────────────────────────────

export const LOG_MANIFEST = {
  food: {
    window: {
      kind: "argued",
      back: "unbounded",
      forward: 0,
      reason:
        "NOT-FUTURE IS THE WHOLE RULE (#4118). The `/history` door's arbitrary past is deliberate — a ledger day is correctable however old — so the past half is genuinely unbounded, and the forward half is what `logFoodServingCore` orders into the core because markup was the only thing between a forged POST and a serving filed in the next century.",
      ref: "#4118",
    },
    statedTime: { kind: "judged", seam: "judgeStatedAt" },
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
    cores: ["logFoodServingCore", "undoFoodServingCore"],
  },

  dose: {
    window: {
      kind: "argued",
      back: 2,
      forward: 2,
      reason:
        "COUPLED TO `MESSAGE_POINTER_RETENTION_DAYS` (lib/notifications/message-pointers.ts, currently 3) and stated rather than flattened: since #2018 a Telegram dose keyboard stays live for exactly this window and the reconcile sweep can only close it while its pointer still exists, so raising this past retention would strand live keyboards permanently. The two move together, window < retention. The band is symmetric because a late after-midnight tap must still land on the reminder's own day.",
      ref: "#614",
    },
    statedTime: { kind: "judged", seam: "dose-guards" },
    offline: { kind: "covered", flow: "dose", alsoFlows: ["skip-dose"] },
    surfaces: {
      sheet: { kind: "covered", via: "log-dose" },
      palette: { kind: "covered", via: ["log-dose"] },
      telegram: { kind: "covered", via: ["dose"] },
      history: { kind: "covered", via: "dose" },
    },
    pieces: {
      form: {
        kind: "unconverged",
        reason:
          "`HistoricalDoseForm` already carries the ruled add/edit dual mode — it is the log-side PROOF of #4424 ruling 1 — but the `/history` door still routes doses to the legacy `DoseBackfillLauncher`, so the domain does not yet have ONE form every surface mounts.",
        ref: "#4424",
      },
      rowControl: {
        kind: "unconverged",
        reason:
          "`DoseConfirmButton`/`DoseStatusControl` are the shape, and the Day ledger still picks between two controls per row by `isToday` while `QuickDoseList` straddles `markTaken`/`resolveDayDoses`; #4316's shared dose-row shape absorbs both.",
        ref: "#4316",
      },
    },
    writeConventions: { kind: "convention" },
    cores: ["markDoseTaken", "markDoseSkipped", "logHistoricalDose"],
  },

  practice: {
    window: {
      kind: "argued",
      back: 30,
      forward: 30,
      reason:
        "Fifteen times the dose window and symmetric, so it does not pass for a typo. A practice is logged in arrears far more often than a dose — a reader reconciling a month of sittings is the ordinary case — and there is no live keyboard to strand, so the #614 posture (a far-off forged date cannot land a misdated row) is kept at a size the domain actually uses. `isPracticeEditDateAccepted` additionally admits a date near an IMPORTED session's own, so an old row stays correctable.",
      ref: "#2908",
    },
    statedTime: {
      kind: "none",
      reason:
        "A session is a DAY's fact plus a duration: `practice_logs` carries no event instant, and the duration answers 'how long', never 'at what minute'. A time field here would collect a statement with nowhere to be stored — the `/history` door makes the same call for substance rows.",
      ref: "#2908",
    },
    offline: { kind: "covered", flow: "practice" },
    surfaces: {
      sheet: { kind: "covered", via: "log-practice" },
      palette: { kind: "covered", via: ["wellness-practices"] },
      telegram: { kind: "covered", via: ["practice"] },
      history: { kind: "covered", via: "practice" },
    },
    pieces: {
      form: {
        kind: "unconverged",
        reason:
          "`LogPracticeButton` carries three incompatible field sets across four mounts, and `app/(app)/upcoming/PracticeLogButton.tsx` fronts a SECOND write core (`logUpcomingPractice`) with no duration and no confirm. #4424 ruling 7 deletes the parallel core; this row flips with it.",
        ref: "#4424",
      },
      rowControl: {
        kind: "unconverged",
        reason:
          "`PracticeSessionHistory` spells its own correction form and the compact `LogPracticeButton` is not yet the one row control every surface mounts.",
        ref: "#4424",
      },
    },
    writeConventions: { kind: "convention" },
    cores: ["logPracticeSession", "logPracticeSessionForDay"],
  },

  mood: {
    // Ordinary: the same two days as a dose, past-only, and nothing about it needs
    // arguing beyond the past-only shape the type already states.
    window: { kind: "ordinary", back: 2, forward: 0 },
    statedTime: {
      kind: "none",
      reason:
        "A check-in is a DAY's answer (#992/#2312, answered rather than left to inference): `MoodPayload` carries no instant, the queue's captured date is the whole of its time model, and a replay at dinner still lands on the day the user tapped.",
      ref: "#992",
    },
    offline: { kind: "covered", flow: "mood" },
    surfaces: {
      sheet: { kind: "covered", via: "log-mood" },
      palette: { kind: "covered", via: ["log-mood"] },
      telegram: { kind: "covered", via: ["mood"] },
      history: {
        kind: "excluded",
        reason:
          "`HISTORY_LOG_KINDS` has no mood row: the check-in store is store-private under the #992 sensitivity contract, and giving the record a mood kind is a decision about that contract rather than about the kind registry.",
        ref: "#4427",
      },
    },
    pieces: {
      form: {
        kind: "unconverged",
        reason:
          "`QuickMoodCheckin` is a declared HALF-form — the expand fields exist on one mount and not the others — so mood has no single form serving add and full-statement edit.",
        ref: "#4427",
      },
      rowControl: {
        kind: "unconverged",
        reason:
          "The readings table's value cell is the row-control-grade edit and the dashboard card's faces are the tap; neither is a shared control any surface can mount.",
        ref: "#4427",
      },
    },
    writeConventions: { kind: "convention" },
    cores: ["upsertMoodLog"],
  },

  symptom: {
    // THE FIRST TENANT (#4425). Until this entry symptoms had no date bound at all:
    // `parseDate` in app/(app)/symptom-actions.ts regex-matched `\d{4}-\d{2}-\d{2}`
    // without `isRealIsoDate` — so `2026-13-45` reached the core as a literal string
    // — and `logSymptomCore` bounded nothing. Matching mood is the ruling, and mood
    // is the honest sibling: a subjective daily self-report, backfilled a day or two
    // late, correctable afterwards from the row rather than re-logged.
    window: { kind: "ordinary", back: 2, forward: 0 },
    statedTime: {
      kind: "none",
      reason:
        "A symptom-day is ONE row, UNIQUE(profile_id, date, symptom), keeping the day's WORST severity: the table has no instant column and a second tap settles onto the same row rather than becoming a second observation. The temperature reading the bar can also take is the `body` domain's, and it states its own time there.",
      ref: "#799",
    },
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
      form: {
        kind: "unconverged",
        reason:
          "`SymptomLogBar` takes 21 props and hand-rolls its own temperature entry (a raw time input on the allowlist) instead of composing the vitals field; the `/history` row correction is a second spelling and posts the subject under a second name.",
        ref: "#4424",
      },
      rowControl: {
        kind: "unconverged",
        reason:
          "The severity-lower confirm is row-control-grade and lives inside the bar; `/history` symptom rows carry a correction form and no shared control.",
        ref: "#4424",
      },
    },
    writeConventions: { kind: "convention" },
    cores: [
      "logSymptomCore",
      "setSymptomSeverityCore",
      "lowerSymptomSeverityCore",
    ],
  },

  stool: {
    window: {
      kind: "argued",
      back: 0,
      forward: 0,
      reason:
        "TODAY-ONLY, and by construction rather than by a guard: `logStoolForm` stamps `today(profile.id)` and the form has no date field at all, so there is no day for a window to bound. The domain has one write mount and no correction anywhere — #4433 owns the backfill and correction legs, and widening the reach is that issue's decision, not this manifest's.",
      ref: "#4433",
    },
    // THE SECOND TENANT (#4425). Until this entry `logBristolStool` ran only
    // `normalizeClockTime` — a SHAPE check — so "Happened earlier?" accepted 23:50
    // typed at 09:00, filing a bowel movement fourteen hours in the future on a row
    // whose natural key IS its instant.
    statedTime: { kind: "judged", seam: "judgeStatedAt" },
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
      reason: "The seven icons are the affordance and the fold is optional, so the row was built as a tap row and kept a tap row's channel when the field arrived (#3273). Recorded rather than fixed here: the refusal this issue teaches it to report rides the same toast, and moving the channel is #3276's pipeline work, not a window fix.",
      ref: "#3276",
    },
    cores: ["logBristolStool"],
  },

  substance: {
    window: {
      kind: "argued",
      back: "unbounded",
      forward: 0,
      reason:
        "The food ledger's sibling shape, spelled the same way in the same words (`addSubstanceDailyTotalCore` is where `logFoodServingCore` copied its bound from): an arbitrary past day is correctable, the future is not. STATED HONESTLY: only the HISTORY core carries it — `logSubstanceUnitCore`, the one-tap counter, re-checks no date and takes whatever its action resolved, which is a gap this manifest names rather than closes.",
      ref: "#4118",
    },
    statedTime: {
      kind: "none",
      reason:
        "`substance_daily_totals` is a DAY TOTAL. It has a `recorded_at` — when the use was filed — and no event instant at all, which is why the record renders these rows date-only and sinks them below the day's timed ones.",
      ref: "#3327",
    },
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
      form: {
        kind: "unconverged",
        reason:
          "The `/history` add door spells its own substance form with an unlabeled amount; the sheet's overlay is a third spelling beside the Medical page's.",
        ref: "#4424",
      },
      rowControl: {
        kind: "unconverged",
        reason:
          "The unit tap and the record's row correction share no control, and the cap-progress line rides only the former.",
        ref: "#4424",
      },
    },
    writeConventions: { kind: "convention" },
    cores: [
      "logSubstanceUnitCore",
      "undoSubstanceUnitCore",
      "addSubstanceDailyTotalCore",
    ],
  },

  body: {
    window: {
      kind: "argued",
      back: "unbounded",
      forward: "unbounded",
      reason:
        "STATED AS IT IS, not as it ought to be: the body-metric cores bound the DATE with `isRealIsoDate` and nothing else, so a reading may be filed on any real day in either direction. What is judged is the stated INSTANT, which cannot be future and must fall on the row's own day — so a forward date is reachable only by a POST, never by the door, whose `maxDate` is today. Whether the core should carry the door's bound is a decision about the body write contract and belongs to #4424's body leg.",
      ref: "#4424",
    },
    statedTime: { kind: "judged", seam: "judgeStatedAt" },
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
      form: {
        kind: "unconverged",
        reason:
          "THREE shapes with three field sets — a 13-field form, a 3-field door, a 1-field row edit — plus `PediatricWeightUpdate` as a fourth weight form and a palette path posting raw `insertBodyMetric` instead of the measurements action.",
        ref: "#4424",
      },
      rowControl: {
        kind: "unconverged",
        reason:
          "The readings-table value cell is the row-control-grade inline edit and is not a shared component; the dashboard Now rows carry no body control at all.",
        ref: "#4424",
      },
    },
    writeConventions: { kind: "convention" },
    cores: ["recordReading", "recordReadings", "logTemperatureCore"],
  },
} as const satisfies Record<LogDomain, LogDomainManifest>;

// ── The one window predicate ─────────────────────────────────────────────────

// Is `date` inside `domain`'s declared backfill window, given the profile's already-
// resolved `todayStr`? THE one realization of every domain's window rule — the dose,
// mood and practice predicates are this function wearing their names, so a window
// can no longer be enforced one way in a core and offered another way in a picker.
//
// Pure: both arguments are YYYY-MM-DD and the caller owns the clock.
//
// `isRealIsoDate` FIRST, and it is load-bearing rather than defensive:
// `daysBetweenDateStr` runs `Date.parse`, which silently ROLLS `2026-02-30` forward
// to March 2 and answers a diff for it. Every predicate that folded into this one
// therefore accepted a day that does not exist; the practice window was the only one
// that had already noticed.
export function isLogDateAccepted(
  domain: LogDomain,
  todayStr: string,
  date: string
): boolean {
  if (!isRealIsoDate(date)) return false;
  const { back, forward } = LOG_MANIFEST[domain].window;
  const diff = daysBetweenDateStr(todayStr, date);
  if (diff == null) return false;
  if (diff < 0) return back === "unbounded" || -diff <= back;
  return forward === "unbounded" || diff <= forward;
}
