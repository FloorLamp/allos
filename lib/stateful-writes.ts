// Lifecycle/counter write owners checked by lib/__tests__/stateful-writes.test.ts.
// The scan detects supported literal SQL outside these cores; computed SQL and
// excluded files remain outside its coverage. It does not prove core correctness
// or that UI callers render offer state and handle typed outcomes.
// Contract: docs/internals/stateful-affordances.md.

export interface StatefulWriteTable {
  // The SQL table name, matched as a whole word directly after INSERT INTO / UPDATE /
  // DELETE FROM.
  table: string;
  // Optional narrowing to SQL mentioning a listed column anywhere, including a
  // WHERE predicate. This is a text match, not an analysis of assigned columns.
  columns?: readonly string[];
  // Repo-relative path SUFFIXES of the modules permitted to hold that DML. Suffix-matched
  // like the profile-scoping allowlist, so a nested path resolves.
  cores: readonly string[];
  // The auth-blind write core layered ABOVE the store, when the guard logic and the SQL
  // live in different modules. Named for review; not itself a scan permission (it holds
  // no DML, which is exactly the point — it can only reach the table through `cores`).
  gate?: string;
  // The shared offer-state derivation an affordance over this table should RENDER, so a
  // label always names the write it will perform (#221/#1892). Absent where the domain's
  // affordance state has not been extracted yet — an honest gap, not a claim.
  offerState?: string;
  why: string;
}

export const STATEFUL_WRITE_TABLES: readonly StatefulWriteTable[] = [
  {
    table: "appointments",
    columns: ["status"],
    cores: ["lib/appointment-status.ts"],
    // No `offerState`, honestly: the list's controls and the palette's hit action
    // each render from the row's status (scheduled → complete/cancel, closed →
    // reopen; appointmentHitActions offers "Mark complete" only while scheduled),
    // but that derivation has not been extracted into one shared pure function.
    // An honest gap, not a claim.
    why: "#2134: `status` is the scheduled/completed/cancelled LIFECYCLE flag — it decides Upcoming membership, the preventive scheduled-match, and which controls a row offers. The user-facing one-taps (Mark completed / Cancel / Reopen, and the palette's Mark complete) were a bare `SET status = ?` that could not refuse, while the import path compare-and-swapped the very same transition — one machine, two disciplines. lib/appointment-status.ts now owns every transition: the state-named CAS with typed already-*/not-found refusals, and the two complete+link swaps (\"Log this visit\" and the import auto-complete, whose scheduled-only guard keeps the machine from overwriting a manual completion or cancellation). Column-narrowed: date/provider/title/location/notes/kind edits are ordinary form writes, the create INSERT's literal 'scheduled' is a born row, and DELETE is not a state transition.",
  },
  {
    table: "cycles",
    cores: ["lib/cycle-store.ts"],
    gate: "lib/cycle-write.ts",
    offerState: "cycleControlState",
    why: "#1892/#1681: period start/end/reopen are LIFECYCLE transitions over an open-period invariant. lib/cycle-write.ts is the auth-blind core — one writeTx per transition, every refusal typed (already-open / duplicate / too-soon / too-old) and enforced with the SAME pure predicates the Cycle page control, dashboard control atom, and quick-log sheet render from (cycleControlState). It reaches the table only through lib/cycle-store.ts, which holds the DML; a raw write anywhere else could mint a second simultaneously-open period, which is precisely the state every derivation assumes cannot exist.",
  },
  {
    table: "illness_episodes",
    cores: ["lib/illness-episode-store.ts", "lib/illness-episode-write.ts"],
    why: "#856/#799: an episode is an open/closed LIFECYCLE row — starting, ending, reopening, and merging it drive the illness front door, the school-return finding, and the recently-resolved dismissal. The store owns the CRUD and lib/illness-episode-write.ts owns the transitions (which is why both are cores, not one plus a gate). A raw close from a third module would leave the episode's associated symptom logs, stopped meds, and encounter links unreconciled — the row-op completeness rule.",
  },
  {
    table: "shared_supplies",
    columns: ["quantity_on_hand", "last_fill_size"],
    cores: [
      "lib/queries/intake/refill.ts",
      "lib/queries/intake/supply-pool.ts",
    ],
    offerState: "refillRecencyLine",
    why: "TWO COLUMNS, TWO REASONS. #1374/#467: the household bottle's counter is written by MANY takers, so every adjustment is a compare-and-set under the IMMEDIATE write lock — refill.ts owns the dose decrement and the relative refill increment, supply-pool.ts owns pool create/edit and the link/unlink transfers. A raw absolute UPDATE from a fourth module would clobber a concurrent taker's decrement, which is the exact accounting split #1374 exists to end. #5911, and NOT that argument: `last_fill_size` is an absolute set, so last-writer-wins is correct for \"the usual refill\" and no clobber hazard reaches it. It is listed because a ONE-TAP reads it back and ADDS it to a HOUSEHOLD count, and a remembered size is reusable only for the container it was a fill of. `rememberedFillFor` (lib/refill.ts) is the one place that rule lives, and ONE core reaches this column through it — refill.ts's pooled branch; supply-pool.ts is here for the counter one column over. So the scan refuses a `last_fill_size`-only write, such as a correction or a backfill, setting a household bottle's usual refill by a route the container rule never ran on. Naming the column is what makes that refusal real: the one write that names it spells `SET quantity_on_hand = ?, last_fill_size = ?`, so before the column was named the counter's own narrowing caught it by statement shape rather than by intent.",
  },
  {
    table: "intake_item_logs",
    cores: [
      "lib/queries/intake/administration-delete.ts",
      "lib/queries/intake/administrations.ts",
      "lib/queries/intake/dose-status.ts",
      "lib/queries/intake/dose-time-correction.ts",
    ],
    // No `offerState`, honestly: DoseStatusControl already renders from the dose's
    // taken/skipped/clear state and each surface gates the control on its own
    // (active && due) read, but that derivation has not been extracted into one shared
    // pure function. An honest gap, not a claim.
    why: "#2039/#232: the dose ledger row is a LIFECYCLE row — taken ↔ skipped ↔ clear — and it is what DRIVES the supply counter one column over, so a parallel core desynchronizes the two. It had one: a tri-state twin in the nutrition Server Action module with its own DELETE/INSERT/UPDATE, its own increment/decrement crossings, and (having drifted) no paused-item refusal at all, while lib/offline/writes.ts already records a THIRD parallel dose writer that drifted and was deleted for it. The lib/queries/intake dose modules now own every transition of the table, each under one BEGIN IMMEDIATE with a typed refusal (stale-dose / inactive / already-taken / already-skipped): dose-status.ts holds the scheduled tri-state and the one-way resolvers, administrations.ts the PRN ledger and the historical-dose corrections, administration-delete.ts the undoable delete and its restore, dose-time-correction.ts the occurred_at-only restamp. FOUR FILES, NOT FOUR CORES — #2960 split one 1,705-line module along its existing section boundaries and moved no behavior; the count here is a file list, and the two write cores (scheduled resolution, administration) are what it always was. A raw INSERT from a module NOT on this list would re-mint the #797 double-decrement the exists-check under the write lock exists to prevent.",
  },
  {
    table: "intake_items",
    columns: ["quantity_on_hand", "active"],
    cores: [
      "lib/queries/intake/refill.ts",
      "lib/queries/intake/supply-pool.ts",
      "lib/intake-active-write.ts",
      "lib/intake-obligation-write.ts",
      "lib/queries/intake/medications.ts",
    ],
    offerState: "refillRecencyLine",
    why: "#467/#1893: the PRIVATE (unpooled) supply counter, same discipline as the pool one column over — refill.ts holds the only increment/decrement, supply-pool.ts nulls and restores it across a link/unlink. #2133 added `active`: it is the pause LIFECYCLE flag, not a form field — a read-then-flip toggle inverted a stale tab's tap — so every flip is a state-named CAS in lib/intake-active-write.ts (supplements) or lib/queries/intake/medications.ts (medications, which must move course history in the same transaction). lib/intake-obligation-write.ts is a core only because its obligation CAS names `active` in its guard WHERE. Column-narrowed because intake_items carries the whole medication/supplement record: name, dose, obligation and cadence edits are ordinary last-write-wins form writes and are none of this gate's business. The item FORM's own absolute write is allowlisted in the scan, as is the ONE create core every door now mints a born row through (#4669).",
  },
  {
    table: "medication_courses",
    cores: ["lib/queries/intake/medications.ts"],
    why: "#2132: the invariant 'intake_items.active = 1 ⇔ an open (stopped_on IS NULL) course exists' was prose enforced in one module but the table was written from THREE — exactly the illness_episodes hazard ('a raw close from a third module would leave … unreconciled'). medications.ts now owns every course transition — stop, restart, end-date, pause-sync, start-date correction, renewal and import creation — each a typed, changes-checked outcome that moves `active` in the SAME transaction. The adherence backdated-extension and the edit form's course-start write reach the table only through setCourseStartDate under the caller's Tx token. A raw close anywhere else would desync scheduling from course history, which is the state every reader assumes cannot exist.",
  },
  {
    table: "intake_item_doses",
    columns: ["retired"],
    cores: ["lib/queries/intake/dose-lifecycle.ts"],
    why: "#2131: `retired` decides whether a dose's child ledger rows are still SCHEDULED — the child table (intake_item_logs) was gated (#2074) while this parent flag was raw SQL in a Server Action with no typed outcome and no reopen. dose-lifecycle.ts owns both transitions: retire-or-delete for removed doses (retire keeps the row precisely because deleting would CASCADE away its taken history) and the guarded un-retire (only a retired dose with no conflicting live slot reopens), each bounding dueness through appended schedule versions (#1973) so neither transition ever re-judges a past day. Column-narrowed: amount/time/window edits on a live dose are ordinary form writes (the edit UPDATE's `retired = 0` guard predicate is allowlisted in the scan).",
  },
  {
    table: "protocols",
    columns: ["end_date"],
    cores: ["lib/protocol-lifecycle.ts"],
    offerState: "protocolReopenEligibility",
    why: "#2135: `end_date` is a THREE-state machine — NULL is ongoing, a recent date is resumable, an old one is expired and the honest move is a new run — and the states were already named once in the pure protocolReopenEligibility, which ProtocolControls renders its Resume/Run again offer from. The WRITE half was the gap: end and resume read the row with getProtocol OUTSIDE the writeTx they then wrote in, swapped with a bare `id = ? AND profile_id = ?` UPDATE that could not refuse, and answered in English strings. lib/protocol-lifecycle.ts now owns both transitions on the cycles shape — in-transaction re-read, CAS on the expected prior end date, typed already-ended / already-ongoing / expired / invalid / not-found — and inverts the protocol's SITUATION activation inside the same transaction, because a protocol reading \"ended\" while its situation stays active keeps firing situational supplements for a block the user has stopped. Column-narrowed: name/notes/outcome/equipment/practice-link edits are ordinary last-write-wins form writes, and DELETE is not a state transition (deleteProtocol carries its own side-state under the row-ops rule). The create INSERT, the run-again INSERT and the edit form's absolute window write are allowlisted in the scan with their justifications.",
  },
  {
    table: "practice_logs",
    columns: ["live"],
    cores: ["lib/practice-log.ts"],
    offerState: "liveSession",
    why: "#3143: `live` distinguishes an open Start-now lifecycle from a complete start-only statement. lib/practice-log.ts owns start, end, and local-day abandonment with typed already-live/not-live refusals; a raw flip could create a second open session or fabricate completion state. Column-narrowed because ordinary session logs, imports, corrections, and deletes remain additive or form-level writes.",
  },
  {
    table: "routines",
    columns: ["active"],
    cores: ["lib/routines.ts"],
    why: "#2140: a real single-active invariant with a de-facto core — activateRoutine deactivates every sibling and installs the derived frequency targets in ONE writeTx, and getActiveRoutine, the deload cycle, the rotation cursor and the workout nudge all assume at most one active row. The invariant was enforced only by convention inside lib/routines.ts; a raw `active = 1` from a second module would mint two simultaneously-active routines and silently fork every one of those readers — the identical hazard the cycles entry names. Column-narrowed: name/cycle_weeks/started_date edits are ordinary form writes, and DELETE (deleteRoutine's explicit child sweep) is not a state transition.",
  },
  {
    table: "situations",
    columns: ["active"],
    cores: ["lib/settings/profile-attrs.ts"],
    why: "#2140: the active-situation set is a LIFECYCLE machine — setActiveSituations does a whole-set rewrite (deactivate all, activate wanted) that gates situational supplements, opens/closes illness episodes (#856) and feeds the coaching layer, with the dated start/stop event log appended from the before/after diff. That diff's before-read now runs inside the same writeTx (readAllForUpdate), and gating the column keeps a second module from flipping `active` without the episode sync and the event log — which would desync the #856 'row and flag never disagree' invariant. Column-narrowed: illness_type opt-ins and the get-or-create INSERT's literal initial value are the vocabulary's ordinary writes.",
  },
  {
    table: "intake_item_side_effects",
    columns: ["resolved"],
    cores: ["lib/queries/intake/medications.ts"],
    why: "#2133 (sibling): `resolved` is an open/closed lifecycle flag and was a blind `SET resolved = 1 - resolved` toggle, so a stale tab's 'Mark resolved' REOPENED an effect someone else had resolved. medications.ts owns the state-named CAS (setMedicationSideEffectResolved), the stop-time capture, the edit form write and the promote-to-allergy resolution — all in one module already, so the gate just keeps a second toggle from growing elsewhere. Column-narrowed: effect/severity/notes edits are ordinary form writes.",
  },
  {
    table: "equipment",
    columns: ["retired"],
    cores: ["lib/equipment.ts"],
    why: "#2138: `retired` is the lifecycle gate that keeps sold/broken gear out of pickers, availability summaries, and workout suggestions (#341) — a flag by the registry's own criterion, and until #2138 its absence here was silence rather than a decision. lib/equipment.ts owns the state-named CAS (setEquipmentRetired): the caller posts the state its render promised, and a swap that did not land is distinguished under the write lock into already-in-that-state versus row-gone, so a silently-failed retire can no longer keep offering sold gear. Column-narrowed: name/weight/category edits and the create INSERT are ordinary form writes, and DELETE (deleteEquipment's changes-checked detach-then-drop) is not a state transition.",
  },
  {
    table: "fasts",
    cores: ["lib/fast-store.ts"],
    gate: "lib/fast-write.ts",
    offerState: "fastControlState",
    why: "#2756: a fast is an open/closed LIFECYCLE row on the `cycles` shape — `ended_at IS NULL` IS the active state, and the one-active-per-profile invariant is what every derivation downstream assumes cannot be violated, the #2757 notification stand-down included. lib/fast-write.ts is the auth-blind core: one writeTx per transition (start / end / reopen-as-Undo / discard / edit-a-recorded-interval), every refusal typed (already-active including the cross-device double-start, none-active, end <= start at the STORED second, a backdated interval that overlaps an existing fast, a discard whose named row was closed elsewhere in the meantime, and an edit whose named row is running again) and enforced with the SAME pure predicates the Nutrition control renders from (fastControlState, lib/fasting.ts). It reaches the table only through lib/fast-store.ts, which holds the DML. A raw write from a third module could mint a second simultaneously-active fast — precisely the state the partial unique index and every reader rule out — or, worse, bypass the life-stage gate the core carries (ADULT_ONLY_WRITE_CORES), which is a safety refusal and not a preference. Not column-narrowed: the table has no non-lifecycle column — `started_at`/`ended_at` ARE the machine and `note` never travels alone. One write does sit outside these cores and is named here rather than left for a reader to discover: Data → Manage's generic bulk row DELETE, which the `fasts` dataset + DELETE_POLICY entry (lib/export.ts) opts into and which builds its statement from the whitelisted dataset table rather than naming this one. A DELETE is not one of this machine's transitions — it cannot mint a second active fast, and REDUCING fasting state is exactly what the life-stage exemption already permits — the same reading `equipment` records above.",
  },
  {
    table: "notify_post_workout_claims",
    cores: ["lib/notifications/post-workout-claim.ts"],
    gate: "lib/notifications/workout-presence.ts",
    why: "#3058: the row IS a two-state LIFECYCLE machine (pending -> sent, plus release) whose unique-key election is the database-enforced 'one post-workout contact per session' property. lib/notifications/workout-presence.ts is the claim-owning core: it re-runs the eligibility/duplicate checks and the election in one immediate transaction, dispatches only as the winner, and answers every loser with a typed already-claimed/already-sent outcome. It reaches the table only through lib/notifications/post-workout-claim.ts, which holds the DML (claim/finalize/release, the lease judgment). A raw write from a third module could mint a second concurrent winner (two contacts for one session — the exact defect), finalize a claim no channel earned, or release a sent claim back into the world; and any module reading the table directly to decide 'may I send?' would be rebuilding the read-then-act sequence the election exists to close. Not column-narrowed: the table has no non-lifecycle column — state and claimed_at ARE the machine.",
  },
  {
    table: "niggles",
    cores: ["lib/niggle-store.ts"],
    offerState: "detectNiggles",
    why: "#2948: the niggle table has ONE transition and it is a compare-and-set — `reportNiggle` either advances the LIVE row on this (region, laterality) key or, when none is live, mints a new one. The invariant it holds is one live niggle per region+side: a person does not have two simultaneous right-knee niggles, and every consumer of the live set (the tempering and the pre-workout heads-up #2948 defers to later parts) reads it assuming that. A raw INSERT from a third module would mint the duplicate, which double-counts the same complaint and is not visible in any UI, since expiry is derived rather than stored. lib/niggle-store.ts holds the only DML; the Server Action above it owns auth and revalidation and cannot reach the table. Not column-narrowed: the table has no non-transition column — region/laterality ARE the key and `last_reported_at` IS the clock, while `body_term` and the source link are born with the row and never travel alone. `offerState` names lib/niggle-extract.ts's `detectNiggles`, the pure derivation the confirm chip renders from, so the chip can only offer a report the detector actually made. One write sits outside the core and is named here rather than left to be discovered: Data → Manage's generic bulk row DELETE, which the `niggles` dataset + DELETE_POLICY entry (lib/export.ts) opts into and which builds its statement from the whitelisted dataset table rather than naming this one. A DELETE is not one of this machine's transitions — it cannot mint a second live niggle — the same reading `equipment` and `fasts` record above.",
  },
  {
    table: "integration_backfill_jobs",
    cores: ["lib/integrations/backfill-jobs.ts"],
    // No `offerState`, honestly: the Strava button renders a count of rides missing
    // details, not the job's own state, so its label does not yet name the write it
    // will perform. It cannot corrupt — queueIntegrationBackfill refuses a
    // running/queued job with a typed outcome the action renders, and the run claim is
    // a CAS on `status IN ('queued','paused')` — but the derivation is not extracted.
    why: "#2196/#2195: the whole row IS a lifecycle checkpoint — `status` drives what the hourly pass resumes, what boot recovery reaps, and whether a re-queue resumes or restarts, while completed/failed/request/active-seconds are the durable counters a resumed run continues from. Not column-narrowed, because the table has no non-lifecycle column: every field is that machine's state. lib/integrations/backfill-jobs.ts is the one core — the queue CAS (running/queued refuses with a typed outcome), the claim CAS, the per-item checkpoint, and the terminal completed/paused/failed write. A raw write elsewhere would either restart counters over intact imported rows (#2195's bug, as a one-liner) or park a job in a status the resume query never selects, which is #2196's stuck job with no fix but hand-editing the DB. The crash-lease reaper in lib/migrations/boot-tasks.ts writes it too and is out of the scan's scope by the migrations carve-out; it is a lease expiry, running before any request exists, not a user-reachable transition.",
  },
  {
    table: "coverage_gaps",
    cores: [
      "lib/queries/coverage.ts",
      "lib/assessment-reclass-db.ts",
      "lib/canonical-alias-merge-db.ts",
    ],
    // No `offerState`, honestly: Data → Coverage renders each row's Track/Stop control
    // from the registry row's own presence and the LIVE "covered now?" verdict
    // getCoverageGapCandidacy computes, but that pairing has not been extracted into one
    // shared pure function. An honest gap, not a claim.
    why: '#5941/#550: the opt-in row IS a durable user decision — "watch this gap until it is filled" — and the table\'s whole discipline is its UNIQUE(profile_id, kind, item_key) identity. lib/queries/coverage.ts owns the user-facing pair: addCoverageGap is an INSERT OR IGNORE plus a read-back so a second Track returns the SAME id rather than a duplicate, and removeCoverageGap is the only profile-scoped drop. The two maintenance writers are cores because a vocabulary change RE-KEYS the row rather than replacing it: lib/canonical-alias-merge-db.ts moves a biomarker gap to the merged name with an UPDATE OR IGNORE and then drops the source row, which is the only correct pair — a bare UPDATE collides with the unique index when the destination is already tracked, and a bare DELETE loses an opt-in the user never withdrew; lib/assessment-reclass-db.ts drops the gap of a name that stopped being a biomarker at all. A raw write from a fourth module would either mint the duplicate tracking row the unique index exists to prevent, or silently un-track a gap the user asked to watch. Not column-narrowed: kind + item_key ARE the identity, label and the AI description are born with the row or written through setCoverageGapAiDescription in the same core, and the table has no non-decision column.',
  },
  {
    table: "deleted_rows",
    cores: [
      "lib/undo-delete-db.ts",
      "lib/bulk-correction-db.ts",
      "lib/queries/intake/administration-delete.ts",
      "lib/sleep-retime-db.ts",
    ],
    // No `offerState`, honestly: the Undo toast and Data → Trash both render from the
    // capture's own presence and its retention window (listTrash's expiresInDays), but
    // that derivation has not been extracted into one shared pure function.
    why: "#5941/#30/#2013: a holding row is the ONLY remaining copy of a deleted row's content, so writing this table is not a cache update — it is custody of the user's data between the delete and the purge. Consuming a row is a two-step the SQL alone does not show: the payload must be read for its captured clip and photo paths BEFORE the DELETE, because unlinkPurgedFiles is what reclaims them, and a raw DELETE elsewhere leaves those files on disk with nothing pointing at them — the #1290 leak re-opened by hand, which is exactly what purgeDeletedRow's own comment says it exists to stop. The by-hand purges also filter TRASH_EXCLUDED_KINDS, so a raw DELETE would destroy a capture the Trash surface deliberately never offers. A raw INSERT is the mirror hazard: restoreDeletedRow dispatches on `kind` through the pure registry (lib/undo-delete.ts) plus three bespoke kinds, so a capture minted outside these modules is one no restore path can reconcile — it would sit in the Trash offering a Restore that cannot work. lib/undo-delete-db.ts owns the generic capture, restore, retention sweep and both by-hand purges; the other three own a bespoke capture their own inversion needs — the bulk correction's before/after snapshot, the PRN administration ledger row (which has no profile_id root of its own), and the sleep re-time. Not column-narrowed: the table has no non-custody column — kind, label and payload ARE the capture.",
  },
  {
    table: "import_tombstones",
    cores: ["lib/document-tombstones.ts", "lib/integrations/tombstones.ts"],
    // No `offerState`, honestly: Data → Review renders the blocked list and its Allow
    // again control from the tombstone rows themselves, but there is no shared pure
    // derivation of that state to name here.
    why: '#5941/#507/#1777: a row here is a REFUSAL the user made — "this came back once and I do not want it back" — and it is the only trace of it, because the thing it refuses was deleted. Both writers are idempotent on the UNIQUE(profile_id, target_table, natural_key) key and both are consulted by an ingest path BEFORE it writes: lib/integrations/tombstones.ts owns the keyed-upsert rows a resync consults so a merged-away or deleted source row is not resurrected, and lib/document-tombstones.ts owns the content-hash rows an acquirer\'s re-offer is checked against, where the label is deliberately REFRESHED on conflict so the blocked list names the file the user would recognize. A raw DELETE from a third module is the whole hazard in one statement: it silently un-blocks a resurrection the user asked to stay gone, and the next sync puts the row back with nothing to say why. A raw INSERT is the other direction — a tombstone nobody asked for blocks an import that should have landed. Not column-narrowed: target_table + natural_key ARE the key and `label` never travels alone.',
  },
  {
    table: "document_coverage_markers",
    cores: ["lib/document-coverage.ts"],
    // No `offerState`: the marker is never rendered as an affordance at all — it is read
    // by the #1776 inventory route as the `covered` list. There is no control whose label
    // could disagree with the write.
    why: '#5941/#1828: the marker is the evidence half of a verdict whose OTHER half is recomputed on every read — it records which bytes were offered and which clinical key covered them, and coveredDocumentHashes re-asks whether that coverage still holds against the documents the profile has right now. That split is the design, and it is what a raw write breaks: lib/document-coverage.ts\'s single upsert is idempotent on (profile_id, content_hash) and refreshes both the key and refused_at, so a scheduled re-offer keeps exactly one row that reads as "still being offered". A second writer would either mint a marker with a clinical key the read predicate cannot match — a hash that leaves `covered` forever and is re-offered every run, which IS #1828 — or delete one whose coverage is still true, and there is no invalidation hook anywhere to tell the difference, because the design deliberately has none. Not column-narrowed: content_hash is the identity and clinical_key + refused_at ARE the evidence.',
  },
  {
    table: "symptom_photos",
    cores: [
      "lib/symptom-photo-write.ts",
      "lib/symptom-log-write.ts",
      "lib/photo/metadata-backfill.ts",
    ],
    // No `offerState`, honestly: the episode photo strip renders its per-photo caption and
    // delete controls from the rows it just read, so the label cannot disagree with the
    // write — but that pairing has not been extracted into one shared pure function.
    why: "#5941/#859/#1093/#1844: the row is the ONLY pointer to a file on disk, and the bytes it points at are a photo of somebody's rash. Three disciplines meet in one table and none of them is visible in the SQL. FILE CUSTODY: deleteSymptomPhotoCore reads `stored_path` BEFORE the DELETE because unlinkPhotoFiles is what reclaims the photo and the thumbnail derived beside it — a raw DELETE elsewhere leaves both on disk with nothing pointing at them, which is the #1290 leak re-opened by hand. DEDUP: the INSERT is preceded by a per-profile lookup on the PROCESSED content hash inside the same writeTx, so a re-upload reuses the row instead of minting a second one over the same bytes. THE STRIPPED BYTES: since #1844 phase 3 nothing may write a row for bytes that did not come through processPhoto — the core stores the file itself, so a row minted elsewhere is the only way to get an un-stripped GPS-carrying photo back into the domain. The two other LITERAL writers are cores because they own the row's own upkeep: lib/symptom-log-write.ts RE-PARENTS a photo's `symptom_log_id` onto the surviving same-date log when a custom symptom is re-keyed (#203 says re-parent, never cascade-drop, and foreign_keys=ON would reject the drop otherwise) and re-keys the denormalized `symptom` label with it, and lib/photo/metadata-backfill.ts writes only mime_type/size_bytes/content_hash on rows whose bytes it just re-encoded. `cores` is NOT the list of everything that writes this table and must not be read as one: lib/undo-delete.ts declares symptom_photos a `deleteExplicitly` child of the `symptom-day` kind, so lib/undo-delete-db.ts deletes rows here on capture and re-inserts them on restore, and lib/profile-delete.ts's erasure sweep reaches it over OWNED_TABLES. Both reach the table through an INTERPOLATED name — the undo machinery's `${child.table}` and `${entity.table}`, the sweep's `${t}` — which this scan cannot read either way, so listing those modules would widen the allowlist and gate nothing. What this entry gates is the statement a new writer would spell with the table named LITERALLY. Contrast episode_stopped_meds below, where lib/undo-delete-db.ts IS a core: there the same module names the table literally, this scan reads that statement, and so the entry has to name the module. Neither sentence spells the DML verb in front of those expressions on purpose — a `why` string is source text like any other, and lib/__tests__/body-metrics-delete-scan.test.ts reads every delete-from-an-interpolation in every production file it walks. Not column-narrowed: content_hash is the dedup identity, stored_path is the file custody, symptom_log_id is the #1093 binding, and caption is the only field a user types.",
  },
  {
    table: "symptom_videos",
    cores: ["lib/symptom-video-write.ts"],
    // No `offerState`, honestly: the clip strip renders its caption and delete controls
    // from the rows it just read, the same shape as the photo strip, and the same shared
    // pure derivation has not been extracted.
    why: "#5941/#1224/#859: the symptom_photos posture for VIDEO, and the same three facts the SQL does not show. A row is the only pointer to a stored clip AND its poster, so deleteSymptomVideoCore reads both paths before the DELETE and hands them to unlinkVideoFiles — a raw DELETE elsewhere strands a seizure or tremor clip on disk with nothing referencing it. The INSERT is preceded by a per-profile content-hash lookup inside the same writeTx, so a re-upload of the identical clip reuses the row. And the clip is stored AS-IS by design (no re-encode, the no-native-dependency line), with `has_location` recording that an embedded GPS atom was DETECTED so the UI can say so — a row minted outside this core would carry that flag's default and claim a clip is clean when nothing looked. lib/symptom-video-write.ts is the one PRODUCTION module holding LITERAL DML on this table, which is the only thing this entry can gate: three e2e files delete rows here directly and sit outside the scan's surface entirely, and lib/profile-delete.ts's erasure sweep reaches the table interpolated over OWNED_TABLES. The undo-delete machinery does NOT, and deliberately: lib/undo-delete.ts records that a clip binds to the DAY and carries no symptom_log_id, so the symptom-day capture leaves clips alone rather than widening what the one-tap destroys. Registering the one literal writer means a second literal one has to argue for itself rather than appear. Not column-narrowed: content_hash is the dedup identity, stored_path/poster_path are the file custody, has_location is the privacy statement, and caption is the only field a user types.",
  },
  {
    table: "episode_stopped_meds",
    cores: [
      "lib/illness-episode-write.ts",
      "lib/illness-episode-store.ts",
      "lib/undo-delete-db.ts",
      "lib/import-persist.ts",
    ],
    // No `offerState`: the reversal record is never rendered as an affordance of its own.
    // The reopen sheet lists what it CAN restore, and that list is
    // getEpisodeReopenMedRestore's re-derivation against the courses as they are now —
    // there is no control whose label could disagree with the write.
    why: "#5941/#1140/#1808/#203: a row here is the REVERSAL RECORD of a write that already happened — \"ending this illness closed these courses\" — and it is the only thing that can undo it. The reopen path does not trust it blindly: getEpisodeReopenMedRestore re-derives what is still restorable by joining the course and checking it is still the LATEST one and still stopped with reason 'illness_resolved'. That is what a raw write breaks in both directions. A row minted elsewhere offers a restore for a course that was never closed by this episode; a row deleted elsewhere silently drops a close the user can no longer reverse, and the episode stops being able to say what it stopped at all — which is why migration 137 made `med_name` a SNAPSHOT that survives the med row being deleted or re-extracted. The four writers are the four legitimate custodians and no more: lib/illness-episode-write.ts mints the record as the courses close and clears it on reopen, lib/illness-episode-store.ts carries it through the row operations the episode itself undergoes (re-parented onto the keeper on merge with UPDATE OR IGNORE then the loser's leftovers dropped, and cleared when the episode is deleted — the #199 side-state rule), lib/undo-delete-db.ts removes it OUTRIGHT when the med itself is erased by hand (a deliberate asymmetry recorded in its own comment: erasing a med is a statement about the med, unlike a document reprocess, which leaves the episode's narrative standing by name), and lib/import-persist.ts frees `item_id`/`course_id` when a profile move leaves the link pointing outside the row's profile, keeping the name snapshot. Not column-narrowed: episode_id + item_id + course_id ARE the reversal, and med_name is the snapshot that makes it readable after the med is gone.",
  },
  {
    table: "instrument_responses",
    cores: ["lib/instrument-records.ts", "lib/import-persist.ts"],
    // No `offerState`: the per-item answers are not an affordance with a label that could
    // disagree with a write. The one derived control over them — the correction form's
    // refusal to retype an administered total — is the core's own typed `answers-derived`
    // outcome, re-counted from these rows on every attempt.
    why: "#5941/#716/#996/#2321: these rows ARE what a screening instrument was answered with, and one of them decides a crisis. selfHarmItemIndex names the self-harm question (PHQ-9's item 9 is the only one today), selfHarmAnswersByRecord reads the stored answer for it, and crisisDecision escalates on that answer INDEPENDENTLY of the total — so a row minted outside these cores can put somebody on a NON-DISMISSIBLE crisis surface who never said so, or take one off who did. The same rows are the edit lock's other half: updateInstrumentScore counts them and answers `answers-derived`, refusing a total change on an administered reading precisely because the answers, not the typed total, are the truth. Both writers mint answers WITH the score they belong to, in one transaction, as ON DELETE CASCADE children of the medical_records row — lib/instrument-records.ts for an in-app administration (both catalogs, #716 and #998), lib/import-persist.ts for a folded instrument score extracted from a document, upserted on (medical_record_id, item_index) and re-parented with its score when a profile move carries the parent across. `cores` is NOT the list of everything that writes this table and must not be read as one: lib/undo-delete.ts registers instrument_responses as a captured CHILD of the clinical-observation kind, so lib/undo-delete-db.ts clears and re-inserts these rows as a score is deleted and restored, and lib/profile-delete.ts's erasure sweep reaches it over OWNED_TABLES. Both name the table through an INTERPOLATION this scan cannot read either way, so listing those modules would widen the allowlist and gate nothing. What this entry gates is the statement a new writer would spell with the table named LITERALLY. Not column-narrowed: item_index + answer ARE the answer, and medical_record_id is what binds them to the score whose band and crisis verdict they decide.",
  },
  {
    table: "substance_log_events",
    cores: ["lib/substance-log-write.ts"],
    // No `offerState`, honestly: the record row's undo/correct/delete controls render from
    // the event they were just read with, so a label cannot disagree with the write — but
    // that pairing has not been extracted into one shared pure derivation.
    why: "#5941/#5026/#1078: a use IS an event (the 2026-09-04 ruling), and this table holds it — one row per use, carrying `occurred_at` and the `time_source` that says whether the minute was STATED by the person or merely recorded. The day counter one table over is the cap's substrate; this is the thing that happened, and the record reads these rows. Every write here moves both, in the SAME transaction, which is the whole reason one module owns it: logSubstanceUnitCore appends the event as the counter goes up, undoSubstanceUnitCore retires the NEWEST event as it comes down (the plain minus control's contract — undo is the inverse of the tap that just happened), and correctSubstanceEventCore re-dates an event and re-judges its stated instant against the day the row will actually sit on, writing nothing when the statement is refused. A row minted elsewhere is a use with no counter behind it; a row removed elsewhere is a use the counter still counts, and the two read back as different numbers for the same day. lib/substance-log-write.ts is the one PRODUCTION module holding LITERAL DML here, which is all this entry can gate. The undo machinery is NOT a core and could not be: lib/undo-delete.ts registers both the `substance-use` event kind and the `substance-history` day kind, and lib/undo-delete-db.ts reaches their tables through an INTERPOLATED name this scan cannot read; lib/profile-delete.ts's erasure sweep reaches this table the same way, over OWNED_TABLES. Registering the one literal writer means a second literal one has to argue for itself rather than appear. Not column-narrowed: substance + date are the ledger key, occurred_at + time_source are the #5026 statement, and notes is the fact a day's first tap carries (#5304).",
  },
  {
    table: "substance_daily_totals",
    cores: ["lib/substance-log-write.ts", "lib/undo-delete-db.ts"],
    // No `offerState`, honestly: the substance card's plus/minus pair and the history
    // row's controls render from the day's units as just read, but that derivation has
    // not been extracted into one shared pure function the way refillRecencyLine is.
    why: "#5941/#1078/#2037: `units` is a per-day COUNTER moved by one tap after another, so an absolute write from a new module clobbers a concurrent one — the shared_supplies hazard above, on a different bottle. The arithmetic is deliberately NOT spelled in any registered module: since #2037 the additive upsert, the guarded clamped decrement, the drop-at-zero and the authoritative re-select are the shared day-counter ledger (lib/day-counter-ledger.ts), which names its table through an INTERPOLATION and is therefore invisible to this scan in both directions — it cannot be a core and does not need to be, because it holds no statement this scan can read. WHAT THIS ENTRY GATES IS THE LITERAL SPELLING, and production holds exactly two, each doing something the ledger does not: lib/substance-log-write.ts backfills `logged_via` onto a day row created before any surface claimed it, COALESCEd so the first claim stands; and lib/undo-delete-db.ts, restoring a captured history row onto a day that has since been re-logged, ADDS the captured units into the survivor rather than minting a duplicate day row, carrying `edited` forward with MAX. Both are merges INTO an existing row, which is the shape a clobber breaks. lib/profile-delete.ts's erasure sweep reaches the table over OWNED_TABLES, interpolated, out of this scan's sight the same way. Not column-narrowed: units is the counter, notes is the day's fact, edited is the correction flag the history row renders, and logged_via is the provenance — there is no ordinary form field here to leave alone.",
  },
  {
    table: "allergy_reactions",
    cores: ["lib/allergy-write.ts"],
    // No `offerState`: the manifestation list is an edit FORM, not an affordance whose
    // label names a transition — the user posts the complete list they are looking at.
    why: "#5941/#1405/#1676: this child table is the real manifestation list, and `allergies.reaction` / `.severity` are a DENORMALIZED COPY of its first row that legacy readers still select. One function maintains both sides in one IMMEDIATE transaction, and that is the only thing keeping the copy true: setAllergyReactions proves the parent belongs to the profile, replaces the whole child list (replace-not-merge, because the edit form posts the complete list the user is looking at, so a removed manifestation must actually disappear), and re-syncs the cached pair from the new row 0 — clearing it when the list empties. A second writer leaves that cache naming a manifestation that is no longer there, or blank while manifestations exist, and what reads the cache is the drug-allergy cross-check and the contrast-safety cross-check. These rows carry NO profile_id of their own — they are scoped through the parent allergy — so a writer that skips this core also skips the only place ownership is established. `cores` is NOT the list of everything that writes this table: lib/undo-delete.ts captures allergy_reactions as a child of the allergy kind, so lib/undo-delete-db.ts removes and re-inserts these rows through an INTERPOLATED name this scan cannot read, and the profile erasure reaches them through their parent. Listing those modules would widen the allowlist and gate nothing. The parent `allergies` table is NOT gated and cannot be on this ruling's terms — app/(app)/records/problems/allergies/actions.ts holds its create and edit DML inline, and the ruling requires a registered core. Not column-narrowed: manifestation + severity + position ARE the list, and allergy_id is the binding the cache is derived across.",
  },
  {
    table: "lesion_photos",
    cores: ["lib/skin-photo-write.ts", "lib/photo/metadata-backfill.ts"],
    // No `offerState`, honestly: the lesion photo series renders its delete control from
    // the rows it just read, the same shape as the episode photo strip, and the same
    // shared pure derivation has not been extracted.
    why: "#5941/#715/#1844/#1290: the symptom_photos posture for a DERMATOLOGY close-up, and the same three facts the SQL does not show. FILE CUSTODY: the row is the only pointer to a stored photo and to the thumbnail derived beside it (lesion_photos carries no thumb_path column — the sibling is computed), so deleteLesionPhotoCore reads `stored_path` BEFORE the row goes and hands both to unlinkPhotoFiles, path-contained to the lesion root; a raw removal elsewhere strands a mole photo on disk with nothing referencing it, which is the #1290 leak re-opened by hand. DEDUP: the INSERT is preceded by a per-profile lookup on the PROCESSED content hash inside the same writeTx, so a re-upload of the identical capture reuses the row instead of minting a second series entry over the same bytes. THE STRIPPED BYTES: since #1844 phase 3 nothing may write a row for bytes that did not come through processPhoto — before it this domain stored the upload verbatim and a close-up kept its GPS and device metadata on disk, so a row minted elsewhere is the only way back to that. lib/photo/metadata-backfill.ts is the second core because it owns the row's own upkeep and nothing else: mime_type/size_bytes/content_hash on rows whose bytes it just re-encoded. `cores` is NOT the list of everything that writes this table: lib/undo-delete.ts declares lesion_photos a `deleteExplicitly` child of the `skin-lesion` kind — lesion_id is a plain REFERENCES with no ON DELETE, so the photos must go first for the lesion delete to land at all — and lib/undo-delete-db.ts therefore removes and re-inserts these rows on capture and restore, DELIBERATELY leaving the files alone so a restored row still points at bytes that exist. lib/profile-delete.ts's erasure sweep reaches the table over OWNED_TABLES. Both name it through an INTERPOLATION this scan cannot read either way, so listing them would widen the allowlist and gate nothing. Not column-narrowed: content_hash is the dedup identity, stored_path is the file custody, lesion_id is the series binding, date is what makes the series chronological, and caption is the only field a user types.",
  },
];

// True when a repo-relative path is one of an entry's registered cores.
export function isStatefulWriteCore(
  rel: string,
  entry: StatefulWriteTable
): boolean {
  return entry.cores.some((c) => rel.endsWith(c));
}

// PURE detector: does this SQL statement WRITE the entry's gated table (and, when the
// entry narrows by column, name one of those columns)?
//
// Deliberately matches only a LITERAL table name directly after the DML verb. A statement
// whose table name is interpolated (`DELETE FROM ${root.table}` — the generic undo-delete
// machinery) is invisible to a text scan and is NOT claimed to be covered; see the scan's
// own documentation of what this does and does not guarantee.
export function writesGatedTable(
  sql: string,
  entry: StatefulWriteTable
): boolean {
  const verb = new RegExp(
    `\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+${entry.table}\\b`,
    "i"
  );
  if (!verb.test(sql)) return false;
  if (!entry.columns) return true;
  return entry.columns.some((c) => new RegExp(`\\b${c}\\b`, "i").test(sql));
}
