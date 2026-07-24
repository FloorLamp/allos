// Supplements & medications (intake) domain types (items, doses, dose/skip
// outcomes, pairs, medication courses/side effects, AI suggestions). Split out of
// lib/types.ts (#319); the `@/lib/types` barrel re-exports everything here, so
// import paths are unchanged.

// How a supplement's day-context is decided: every day; only on
// workout/rest days (from the journal); or only while a named situation
// (e.g. "Illness") is active.
export type SupplementCondition =
  "daily" | "pre_workout" | "post_workout" | "rest_day" | "situational";

// Importance band. `mandatory` is reserved for lab-confirmed deficiencies
// (normally set by the AI engine); `high`/`low` are user-managed.
//
// This is a STATIC, user-owned sort key — never recomputed from context (#559).
// Unlike a screening/retest priority (#517), which DERIVES a clinical judgment the
// user can't encode, a supplement's importance is the user's own explicit tag: the
// ground truth, not something to infer. So there is deliberately NO dynamic priority
// ENGINE for supplements — context only GATES dueness (isDueOn hides a rest-day item
// on a workout day, a situational item while inactive), it never INVENTS priority.
// The one legitimately-dynamic axis is time-urgency (a due-but-unconfirmed
// time-critical dose escalating as its window passes), and that rides the EXISTING
// dose-reminder/missed-dose escalation lattice, not this band.
export type SupplementPriority = "mandatory" | "high" | "low";

// How a dose relates to food. A property of the substance (fat-soluble vitamins
// need dietary fat; plant sterols go before a meal; some must be on an empty
// stomach), defaulted from the catalog and editable per dose.
export type FoodTiming =
  "any" | "with_food" | "with_fat" | "before_meal" | "empty_stomach";

export interface Supplement {
  id: number;
  name: string;
  notes: string | null;
  active: number;
  created_at: string;
  condition: SupplementCondition;
  priority: SupplementPriority;
  brand: string | null; // manufacturer, e.g. "Thorne" (free text)
  product: string | null; // specific product/SKU (free text)
  // Situational context (condition = 'situational'). `situation` is the display
  // label (COALESCEd from the linked row's name on read); `situation_id` links to
  // the id-keyed `situations` row (issue #560) — the durable identity that survives
  // a rename and unifies the profile's situation vocabulary. NULL for non-situational
  // or legacy/unmatched rows.
  situation: string | null;
  situation_id: number | null;
  // The INVERSE situational link (issue #1296): while `pause_situation` is active,
  // this item is HELD — not due on any surfacing path (Upcoming, dose strips,
  // reminders, digest), regardless of its `condition`. `pause_situation` is the
  // display label (joined from the linked row's name on read); `pause_situation_id`
  // links the id-keyed `situations` row (migration 108, the mirror of situation_id).
  // NULL when the item isn't situationally paused. An item may carry BOTH links
  // (on-during A, paused-during B) — held beats due (see heldBySituation / isDueOn).
  pause_situation: string | null;
  pause_situation_id: number | null;
  // Optional "stack" label grouping supplements taken together (e.g. "D3 + K2");
  // members render adjacently in their time bucket. Free text.
  stack: string | null;
  // Missed-dose escalation. critical=1 opts this
  // (medication) into a follow-up nudge when a sent dose reminder goes
  // unconfirmed; escalate_after_min is the wait after the slot's reminder
  // (null → a sensible default); escalate_chat_id optionally routes the
  // escalation to a second chat (e.g. a caregiver) instead of the profile's own.
  critical: number;
  escalate_after_min: number | null;
  escalate_chat_id: string | null;
  // Refill tracking. quantity_on_hand is the units left
  // (NULL = not tracked); qty_per_dose is units consumed per confirmed dose
  // (defaults to 1). Decremented on the "taken" path; drives "≈N days left".
  quantity_on_hand: number | null;
  qty_per_dose: number;
  // The number of units the item was LAST refilled by (issue #852 item 3), NULL until
  // the first "Refilled" one-tap records it. Remembered so subsequent refills reuse the
  // size without re-asking; NOT the on-hand counter.
  last_fill_size: number | null;
  // Medication identity. kind splits medications from
  // supplements (shared table/machinery); prescriber/pharmacy/rx_number are
  // medication-only free text; as_needed (0/1) marks a PRN med that generates no
  // scheduled reminders/escalation/adherence-due (an as-needed med is never
  // "missed"). Dose strength (mg/IU) reuses the existing dose `amount`.
  kind: SupplementKind;
  prescriber: string | null;
  pharmacy: string | null;
  rx_number: string | null;
  // Rx / OTC identity (issue #851, migration 045). 1 = prescription, 0 = over-the-
  // counter. Derived on backfill (a prescriber or Rx number ⇒ Rx, else OTC) and kept
  // in sync by the form + the combobox pick. Drives the "Rx"/"OTC" badge and gates the
  // prescriber/pharmacy/Rx-number/provider fields (they show only for a prescription).
  // Always 0 for a supplement (the flag is a medication concept).
  rx: number;
  as_needed: number;
  // PRN redose notice (issue #798). A per-item, opt-in, administration-armed
  // reminder for the redose window opening ("6h since Ibuprofen — your minimum
  // interval has passed · 2 of 4 today"). redose_notice is the opt-in flag;
  // min_interval_hours / max_daily_count are the user-CONFIRMED label numbers
  // (pre-filled from lib/prn-defaults, never applied silently). The notice fires only
  // when redose_notice=1 AND both are set — an unconfirmed/empty field means NO
  // notice, ever (the liability line). max_daily_count also drives the over-max care
  // finding. All null/0 for non-PRN and legacy rows.
  min_interval_hours: number | null;
  max_daily_count: number | null;
  redose_notice: number;
  // Cached RxNorm concept id (RxCUI) for this item's name (issue #144), resolved
  // via NLM's approximateTerm API and user-confirmed on the edit form; NULL when
  // never resolved (the interaction matcher then falls back to name matching).
  rxcui: string | null;
  // Cached ACTIVE-INGREDIENT RxCUIs for the confirmed rxcui (issue #279): a JSON
  // array of code strings resolved via RxNav `/rxcui/{id}/related?tty=IN` at
  // confirm time. A combination product's single product-level rxcui never appears
  // in the ingredient-keyed interaction datasets, so both matchers also try each
  // of these. NULL when unresolved (product-rxcui + name matching still apply).
  // Decode with parseRxcuiIngredients (lib/rxnorm.ts).
  rxcui_ingredients: string | null;
  // Provenance. source is 'manual' for
  // hand-entered rows and 'extracted' for medications auto-structured from an
  // uploaded prescription document; document_id points at that source document
  // (NULL for manual/legacy rows). The extraction persist replaces/removes only
  // the (profile, document_id, source='extracted') set, never a manual row.
  document_id: number | null;
  source: string | null;
  // The prescribing provider — a medication links to the shared
  // GLOBAL registry via provider_id; provider_name is joined for display. NULL for
  // supplements and unlinked medications. Under #1051 semantics decision (a) this is
  // the prescriber (an INDIVIDUAL); the pharmacy free text holds the org half.
  provider_id: number | null;
  provider_name?: string | null;
  // The prescription medical_records row this medication was projected from (#1051):
  // provenance, and the transitive "Prescribed at" chain once that record links its
  // visit. NULL for manual meds / supplements.
  source_record_id: number | null;
  // The condition this medication treats — the med → indication link (#1052). NULL
  // when unlinked. indication_condition_name is joined for the "For:" display line.
  indication_condition_id: number | null;
  indication_condition_name?: string | null;
}

// Whether a row is an ordinary supplement or a prescription medication.
// Same table, same dose/schedule/adherence machinery; the UI
// groups by this and reveals the stricter medication fields.
export type SupplementKind = "supplement" | "medication";

// One scheduled intake of a supplement. A supplement has one or more doses, so a
// split dose (e.g. 1200 mg omega-3 across two fat meals) is two dose rows, each
// with its own amount, time, and food relationship.
export interface SupplementDose {
  id: number;
  item_id: number;
  amount: string | null; // e.g. "600 mg", "1 cap"
  time_of_day: string | null; // bucketed via timeBucket()
  food_timing: FoodTiming;
  sort: number;
  // Soft-retire flag: 1 when an edit removed the dose from the schedule but it
  // was kept because adherence logs reference it. Retired doses are excluded
  // from every "current schedule" read (getSupplementDoses) and are never
  // loggable; history reads still join them.
  retired: 0 | 1;
  // Dose lifetime timestamps (#430, migration 021). created_at is when the dose
  // was first scheduled (backfilled from the parent item for pre-migration rows);
  // updated_at is set whenever the schedule/time is edited, so the adherence-
  // pattern window can restart at a re-time instead of re-accusing the old slot.
  // Nullable — a dose inserted by a path that doesn't stamp them falls back to the
  // parent item's created_at (see doseAdherenceSince).
  created_at: string | null;
  updated_at: string | null;
}

// A dose's resolution on a given day. A skip is a first-class LOG ROW (issue
// #232): a deliberate "chose not to take it" that is neither a taken dose nor a
// silent miss. Stored in intake_item_logs.status (DEFAULT 'taken', so every
// pre-#232 row reads as taken).
export type DoseStatus = "taken" | "skipped";
//    "invalid"   → title/date failed the server-side guard; nothing written
//    "not-owned" → the untrusted form id isn't the active profile's; nothing written

// Outcome of an attempt to log a dose as taken/skipped (markDoseTaken /
// markDoseSkipped). Lets the Telegram callback answer honestly instead of
// claiming "Logged" for a tap on a button whose dose has since been
// deleted/retired or whose item was paused. An already-resolved dose carries
// the prior log's ACTUAL status (issue #280) — never a flat "already logged":
// a stale ⏭ tap on a taken dose (or ✅ on a skipped one) writes nothing, so
// the answer must state what is really persisted instead of letting each
// button type confirm its own action against the other's log.
export type DoseTakenOutcome =
  | "logged" // a new taken log row was written
  | "skipped" // a new skipped log row was written (issue #232)
  | "already-taken" // dose+date already resolved as TAKEN; nothing written
  | "already-skipped" // dose+date already resolved as SKIPPED; nothing written
  | "stale-dose" // dose deleted/retired (or not this profile's): nothing logged
  | "inactive"; // parent item is paused/stopped: nothing logged

// Outcome of logging one PRN (as-needed) ADMINISTRATION (logAdministration, issue
// #797). Unlike markDoseTaken — which enforces one-per-day for a SCHEDULED dose —
// a PRN med can be given several times a day, so each successful log is a NEW row.
// The typed result lets the dashboard widget and the Telegram tap answer honestly
// (the markDoseTaken contract) instead of unconditionally confirming a non-
// idempotent write:
//   logged     — a fresh administration row was written; `count` is the item's
//                running total for `date` and `lastGivenAt` its latest intake time.
//   duplicate  — a same-dose administration already exists within the short double-
//                tap window (a re-tapped button / retried callback); nothing written,
//                supply untouched, and the standing count/last-time reported.
//   invalid-time — the supplied given_at failed the window guard (#614: a forged or
//                far-off time); nothing written.
//   stale-item — the item isn't this profile's, has no loggable (non-retired) dose,
//                or was deleted; nothing written.
//   inactive   — the item is paused/stopped; nothing written.
export type AdministrationOutcome =
  | { kind: "logged"; count: number; lastGivenAt: string; date: string }
  | { kind: "duplicate"; count: number; lastGivenAt: string; date: string }
  | { kind: "invalid-time" }
  | { kind: "stale-item" }
  | { kind: "inactive" };

// Outcome of the explicit medication-history backfill. Unlike the quick-log path,
// this accepts a user-picked date/time in the history-correction window and may log
// against a stopped medication when that date falls inside one of its courses.
// PRN doses keep their per-administration ledger semantics.
export type HistoricalDoseOutcome =
  | { kind: "logged"; date: string }
  | { kind: "already-taken" }
  | { kind: "already-skipped" }
  | { kind: "duplicate" }
  | { kind: "invalid-time" }
  | { kind: "outside-course" }
  | { kind: "stale-dose" };

// Outcome of a caregiver's "👍 I'm on it" acknowledgement on a missed-dose
// escalation (issue #233). Unlike "✅ Confirmed taken" (which routes through
// markDoseTaken and logs the dose), an ack NEVER claims the dose was taken — it
// only records that the episode is being handled, so the tick stops re-nudging.
// The staleness/paused cases mirror DoseTakenOutcome so a stale tap is answered
// honestly; "already-taken" tells the caregiver the dose is in fact confirmed,
// and "already-skipped" (issue #280) that it was deliberately skipped — an
// episode that's over must not be answered as a fresh "we'll hold off".
export type EscalationAckOutcome =
  | "acknowledged" // episode marked handled; dose NOT logged as taken
  | "already-taken" // a taken log already exists for the day — nothing to chase
  | "already-skipped" // a skipped log already resolves the day — nothing to chase
  | "stale-dose" // dose deleted/retired (or not this profile's): nothing recorded
  | "inactive"; // parent item is paused/stopped: nothing recorded

// A relationship between two supplements: take them together (synergy) or keep
// them apart (antagonism). `separate` pairs raise a warning when both land in
// the same time bucket.
export type PairRelation = "with" | "separate";

export interface SupplementPair {
  id: number;
  a_id: number;
  b_id: number;
  relation: PairRelation;
  note: string | null;
  // Joined names for display.
  a_name?: string;
  b_name?: string;
}

// Medication history / lifecycle. A medication's real-world
// use is a sequence of COURSES (episodes): a course opens when the med is started
// and closes when it's stopped, so restarting a med after a break is a NEW course
// rather than an edit of the old one. `intake_items.active` stays the live
// "currently taken" flag scheduling/reminders read; a med is "current" exactly
// when it has an open (stopped_on IS NULL) course.
export type MedStopReason =
  | "side_effect"
  | "ineffective"
  | "completed_course"
  | "switched"
  | "provider_discontinued"
  | "cost"
  // The episode-end reconciliation (issue #880): a course closed because the illness it
  // was taken for resolved (the 2am ibuprofen retired when the flu ends). stop_reason is
  // unconstrained TEXT, so appending here needs no migration.
  | "illness_resolved"
  | "other";

// One episode of taking a medication (a child of intake_items). started_on is the
// episode start; stopped_on NULL means the course is still open (the med is
// currently taken). stop_reason is a controlled MedStopReason; free-text detail
// for 'other' (or any reason) lives in notes.
export interface MedicationCourse {
  id: number;
  item_id: number;
  started_on: string | null;
  stopped_on: string | null;
  stop_reason: MedStopReason | null;
  notes: string | null;
  // Per-course attribution (#1204): the prescriber of THIS course (free text +
  // resolved individual provider_id) and a descriptive dose/sig snapshot as
  // prescribed at this renewal. Null on a manual course / a course with no snapshot.
  prescriber: string | null;
  provider_id: number | null;
  dose_snapshot: string | null;
  created_at: string;
}

export type SideEffectSeverity = "mild" | "moderate" | "severe";

// A side effect noted against a medication (a child of intake_items), optionally
// linked to the course it occurred during (course_id → medication_courses, SET
// NULL if that course row is later removed). resolved marks it as no longer
// ongoing. A side effect can be promoted to an allergies/intolerance row.
export interface MedicationSideEffect {
  id: number;
  item_id: number;
  course_id: number | null;
  effect: string;
  severity: SideEffectSeverity | null;
  noted_on: string | null;
  notes: string | null;
  resolved: number;
  created_at: string;
}

// Runtime array is the single source for the union AND the suggestions.status CHECK
// (enum-parity test).
export const SUGGESTION_STATUSES = [
  "pending",
  "accepted",
  "dismissed",
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

// An AI-proposed supplement awaiting user review (see intake_item_suggestions).
export interface SupplementSuggestion {
  id: number;
  name: string;
  dosage: string | null;
  time_of_day: string | null;
  food_timing: FoodTiming;
  condition: SupplementCondition;
  priority: SupplementPriority;
  brand: string | null;
  product: string | null;
  situation: string | null;
  rationale: string;
  trigger: string | null; // 'labs' | 'feedback'
  source_detail: string | null; // lab names referenced, or the feedback text
  status: SuggestionStatus;
  model: string | null;
  created_at: string;
}
