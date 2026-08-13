import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// Write-access enforcement scanner (issue #33). The mirror of the profile-scoping
// leak test: it reads the repo's own Server Actions as TEXT (no DB, no network,
// so it stays "pure" in the vitest sense), extracts every EXPORTED async function
// from `app/**/*actions.ts`, and fails the build if a mutating action forgets to
// gate itself.
//
// THE RULE: an exported Server Action is authorized to mutate a profile's data
// only if its body calls `requireWriteAccess()` (write-gated: admins pass, a
// read-only-granted member is bounced) OR `requireAdmin()` (admins are implicit
// all-write, so an admin-only action is inherently write-authorized). Everything
// else — reads, login-scoped prefs, session/auth entry points, and thin wrappers
// that delegate to a gated helper — must be on the SHORT allowlist below, each
// with a one-line justification. A NEW action that forgets the check matches
// neither and fails here, which is the entire point: enforcement can't silently
// regress as the surface grows.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Whole modules whose exports share one authorization tier by construction. This
// is narrower than an action-by-action exemption: every otherwise-ungated export
// in the module must call one of the declared gates, and the module entry is reaped
// if the file disappears. Per-action exceptions remain in ALLOW below.
const MODULE_ALLOW = [
  {
    file: "app/(app)/settings/actions.ts",
    gates: ["requireSession", "requireLoginWriteAccess"],
    why: "the module is login-scoped by construction; every export authenticates the caller through requireSession or its demo-safe write variant, while admin/global and profile-owned settings live in separate modules",
  },
] as const;

// Allowlisted exported actions that legitimately do NOT call requireWriteAccess()
// / requireAdmin(), keyed by the file they live in (so an unrelated file can't
// ride the exemption) and the function name. Keep this list SHORT and justified.
//
// `gate` (issue #278): a login-scoped action that mutates the caller's LOGIN auth
// state (password, 2FA, sessions) must still refuse in demo mode — the shared
// public demo login would otherwise let one visitor lock everyone else out. Such
// an entry names the guard its body MUST call (requireLoginWriteAccess); the scan
// fails if the call disappears, so the demo gate can't silently regress back to a
// bare requireSession().
const ALLOW: { file: string; fn: string; why: string; gate?: string }[] = [
  // --- Read-only actions (return data, mutate nothing) ---
  {
    file: "app/(app)/data/actions.ts",
    fn: "getImportJobs",
    why: "read-only: lists the profile's import jobs for the review UI",
  },
  {
    file: "app/(app)/data/review-actions.ts",
    fn: "loadSyncRows",
    why: "read-only (#1333): resolves one sync event's per-row provenance (getSyncRowProvenance) for the Connected-sources drill-in — profile-scoped read, writes nothing, so login-scoped requireSession() is the right gate",
  },
  {
    file: "app/(app)/quick-entry-actions.ts",
    fn: "loadQuickEntry",
    why: "read-only (#1468): gathers the props for the quick-entry overlay's forms (unit prefs, the day's food servings + ordered catalog, today's due doses) — every WRITE still goes through the mounted form's own gated action (addMeasurements / logFoodServing / markTaken), so login-scoped requireSession() is the right gate",
  },
  {
    file: "app/(app)/log-sheet-actions.ts",
    fn: "loadLogSheetContext",
    why: "read-only (#2651): gathers the log sheet's due-and-usual context row — the composed usual-routine offer (getUsualRoutineOffer) and today's due-dose COUNT (collectHouseholdRollup) — and writes nothing; every tap still goes through the control's own gated action (logUsualRoutine / markTaken), so login-scoped requireSession() is the right gate, same posture as loadQuickEntry",
  },
  {
    file: "app/(app)/search-actions.ts",
    fn: "runGlobalSearch",
    why: "read-only: cross-domain search of the active profile",
  },
  {
    file: "app/(app)/search-actions.ts",
    fn: "askRecordsAction",
    why: "read-only (#878): retrieves the active profile's OWN rows (profile-scoped search) and narrates a grounded answer via the AI resolver; computes no fact and writes nothing, so login-scoped requireSession() is the right gate",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "explainFindingAction",
    why: "read-only (#878): narrates a finding's OWN reason payload via the AI resolver; computes no fact and writes nothing, so login-scoped requireSession() is the right gate",
  },
  {
    file: "app/(app)/training/activity-actions.ts",
    fn: "loadTrainingLogPage",
    why: "read-only: fetches an older window of the active profile's Training Log feed for server-side paging (#451); `before` is a date cursor, not a profile selector",
  },
  {
    file: "app/(app)/integrations/sync-actions.ts",
    fn: "loadSyncHistoryPage",
    why: "read-only: fetches an older page of the active profile's provider-scoped sync ledger; the cursor selects a profile-local day and the action writes nothing, so requireSession() is the right gate",
  },
  {
    file: "app/(app)/integrations/sync-actions.ts",
    fn: "loadSyncHistoryRuns",
    why: "read-only: resolves bounded event ids from the active profile's provider-scoped sync ledger for an expanded range and writes nothing, so requireSession() is the right gate",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "dismissMultiviewHintAction",
    why: "login-scoped: dismisses the caller's OWN one-time multi-view discoverability hint (a 'seen' flag in login_settings, #1327), not profile-owned data — same shape as saveUnitPrefs, so requireSession() is the right gate; no demo-gating needed (a harmless per-login UI flag)",
  },
  {
    file: "app/(app)/actions.ts",
    fn: "saveAttentionHeroCollapsed",
    why: "login-scoped: stores the caller's OWN dashboard hero collapse preference (a display-density flag in login_settings, #1413), not profile-owned data — same shape as saveUnitPrefs/dismissMultiviewHintAction, so requireSession() is the right gate. Deliberately NOT requireWriteAccess: a read-only viewer of someone else's profile still gets to choose how tall the card is on their own screen. It cannot hide the hero or its count (#449) — the stored flag is one input to attentionHeroState, which ignores it entirely for a safety-locked hero",
  },
  {
    file: "app/(app)/actions.ts",
    fn: "dismissRecentlyResolved",
    why: "login-scoped: stores the caller's OWN hide of a 'Recently resolved — reopen?' line (a JSON id set in login_settings, #1548), not profile-owned data — same shape as saveAttentionHeroCollapsed, so requireSession() is the right gate. Deliberately NOT requireWriteAccess: a read-only caregiver may still tidy their own dashboard, and the hide is per-login so a co-caregiver's copy is untouched. The episode id IS authorized here — getAccessibleProfiles() feeds the auth-blind write core, which refuses any id outside that set's reopen-eligible ids; it can never reopen, close, or re-window an episode",
  },
  {
    file: "app/(app)/whats-new/actions.ts",
    fn: "markWhatsNewSeenAction",
    why: "login-scoped: records that the caller's OWN login has opened the bundled release notes (a date marker in login_settings, #1421), not profile-owned data — same shape as saveUnitPrefs/dismissMultiviewHintAction, so requireSession() is the right gate; no demo-gating needed (a harmless per-login UI marker)",
  },
  // Login-scoped settings normally ride the structural MODULE_ALLOW gate. These
  // mutations can disrupt every visitor sharing the public demo login, so their
  // stronger demo-safe gate remains declared per action.
  ...[
    "changeOwnPassword",
    "saveOwnProfile",
    "revokeSessionAction",
    "signOutOtherSessions",
    "begin2fa",
    "activate2fa",
  ].map((fn) => ({
    file: "app/(app)/settings/actions.ts",
    fn,
    why: "login-scoped security/auth mutation that must refuse the shared demo login",
    gate: "requireLoginWriteAccess",
  })),
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "bindIdentityAction",
    why: "cross-profile write (#1739): binds a portal patient label to a TARGET profile, which is not necessarily the session's active one — binding grandma's portal patient to grandma's profile from your own session is the normal case, so requireWriteAccess() (which checks only the ACTIVE profile) is the wrong gate. It calls requireProfileWriteAccess(profileId) instead: the #31 cross-profile guard, which refuses in demo mode, asserts the caller can REACH the target, and asserts WRITE on it — strictly stronger here than the active-profile check. When the typed label is already LIVE-BOUND to a different profile the action is a RE-POINT, not a bind (#2103), and it takes remapIdentityAction's discipline: requireProfileWriteAccess on BOTH the current owner (resolved from the row, #1747) and the target, then remapPortalIdentity's compare-and-swap",
    gate: "requireProfileWriteAccess",
  },
  {
    file: "app/(app)/undo-actions.ts",
    fn: "undoDelete",
    why: "cross-profile restore (#2104): an undo token's capture carries the ROW's profile — on a multi-view surface not the acting one (the delete stamped it through gateItemProfile) — so the restore resolves that profile FROM THE HOLDING ROW (deletedRowProfile, the portalIdentityProfile shape #1747) and gates it with requireProfileWriteAccess. requireWriteAccess() gated the ACTING profile, which both killed every legitimate cross-profile undo (capture said Mia, restore filtered by Dad, the toast failed and the capture purged) and authorized nothing about the profile actually written. restoreDeletedRow keeps its profile_id filter as the anti-replay compare",
    gate: "requireProfileWriteAccess",
  },
  {
    file: "app/(app)/undo-actions.ts",
    fn: "undoDeletes",
    why: "cross-profile restore (#2104): the batch twin of undoDelete — each token's owning profile is resolved from its capture and every DISTINCT owner is gated with requireProfileWriteAccess BEFORE anything restores, so a forged token cannot ride in on a legitimate batch (an auth refusal aborts the whole batch; #202's per-token isolation still covers integrity failures inside the restore itself)",
    gate: "requireProfileWriteAccess",
  },
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "unbindIdentityAction",
    why: "cross-profile write (#1739): removing a binding changes where that patient's future records go (namely nowhere — they are refused), the same class of decision as creating one, so it takes the same requireProfileWriteAccess gate on the profile the binding currently points at. That profile is RESOLVED FROM THE ROW server-side, never read from the post (#1747): gating on a client-supplied profile id authorized nothing, because nothing tied it to the binding actually being deleted. An IGNORED binding has no profile by CHECK, so that branch takes the any-profile-write gate and a delete scoped to `ignored = 1`",
    gate: "requireProfileWriteAccess",
  },
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "bindPendingIdentityAction",
    why: "cross-profile write (#1739): the one-tap version of bindIdentityAction — it binds a REPORTED-but-unplaced portal identity to a TARGET profile, taking the (login, patient label) off the pending row server-side so the caller cannot retype them into a subtly different key. Same class of write, same gate: requireProfileWriteAccess(profileId) on the target, not requireWriteAccess() on the session's active profile",
    gate: "requireProfileWriteAccess",
  },
  // ignorePendingIdentityAction needs no entry since #1875: durable Ignore is
  // admin-only, so the body calls requireAdmin() and the scan accepts it directly.
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "remapIdentityAction",
    why: "cross-profile write (#1836): atomically re-points a binding from the profile it CURRENTLY names to a TARGET profile — records routed away from one person and onto another — so it gates with requireProfileWriteAccess TWICE, once per side, and neither side is necessarily the session's active profile (requireWriteAccess would assert the wrong thing). The current owner is RESOLVED FROM THE ROW server-side (#1747); the posted expected_profile_id is only the compare half of the CAS, refused with a typed outcome when stale",
    gate: "requireProfileWriteAccess",
  },
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "dismissPendingIdentityAction",
    why: "pending-list write that ROUTES NOTHING (#1739): clears one prompt row and nothing else — the identity returns if the tool reports it again. Same gate and same reasoning as ignorePendingIdentityAction: no profile to target, so requireAnyProfileWriteAccess()",
    gate: "requireAnyProfileWriteAccess",
  },
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "requestSyncAction",
    why: "portal-login write that ROUTES NOTHING (#1757): it raises a SYNC REQUEST keyed to a portal LOGIN — an ask that somebody run the companion tool — and the row carries no profile_id and cannot (the same request covers every patient bound under that login). There is therefore no target for requireProfileWriteAccess, and requireWriteAccess would assert the session's ACTIVE profile, which is unrelated to a portal login. Same gate and same population as the pending-list actions beside it: requireAnyProfileWriteAccess() — session + demo refusal + WRITE on at least one reachable profile, i.e. someone who could act on the records a run would bring in. A read-only caregiver cannot raise one",
    gate: "requireAnyProfileWriteAccess",
  },
  {
    file: "app/(app)/settings/token-actions.ts",
    fn: "createApiTokenAction",
    why: "login-scoped (#1734): mints an API token on the caller's OWN login — a way to PRESENT that login, not profile-owned data, and it grants no access the login doesn't already have (every bearer route re-derives profile reach through accessForProfile at request time). requireWriteAccess() would be the wrong gate twice: it checks the ACTIVE profile, and it would refuse a read-only caregiver their own credentials. Demo-gated so the shared public demo login can't mint a credential that outlives the visit",
    gate: "requireLoginWriteAccess",
  },
  {
    file: "app/(app)/settings/token-actions.ts",
    fn: "revokeApiTokenAction",
    why: "login-scoped (#1734): revokes an API token — the caller's own, or any token when the caller is an admin (who can already delete the whole login). Same tier as revokeSessionAction, and demo-gated so one visitor can't revoke another's",
    gate: "requireLoginWriteAccess",
  },
  {
    file: "app/(app)/integrations/calendar-feed/actions.ts",
    fn: "enableConsolidatedCalendarFeedAction",
    why: "login-scoped: mints the family .ics token keyed by login.id (like a push subscription); the feed only exposes appointments the login can already READ, so a read-only member may manage it",
  },
  {
    file: "app/(app)/integrations/calendar-feed/actions.ts",
    fn: "disableConsolidatedCalendarFeedAction",
    why: "login-scoped: revokes the caller's own family .ics token (login.id), not profile-owned data",
  },
  // --- Session / auth entry points (no profile-owned data mutation) ---
  {
    file: "app/(app)/session-actions.ts",
    fn: "logoutAction",
    why: "session teardown; touches only the session, no profile-owned data",
  },
  {
    file: "app/(app)/profile-context-actions.ts",
    fn: "switchProfileAction",
    why: "moves the session's active-profile pointer (setActiveProfile re-checks accessibility); not a write to profile-owned data, and read-only members must still be able to switch profiles",
  },
  {
    file: "app/(app)/profile-context-actions.ts",
    fn: "setViewProfileAction",
    why: "toggles the session's multi-profile VIEW-SET (#1096), a READ overlay only (toggleViewProfile is grant-validated: an ungranted id is a no-op); mutates no profile-owned data, and read-only members must still be able to view profiles",
  },
  {
    file: "app/(auth)/login/actions.ts",
    fn: "login",
    why: "public auth entry point; runs before any session/profile exists",
  },
  {
    file: "app/(auth)/login/actions.ts",
    fn: "verifyLoginTotp",
    why: "public auth entry point (issue #23 second-factor step); completes a pre-session 2FA challenge, mints the session — no profile-owned data",
  },
  {
    file: "app/(auth)/forgot-password/actions.ts",
    fn: "requestPasswordReset",
    why: "public auth entry point (issue #985); enumeration-safe + rate-limited self-service reset REQUEST, runs before any session exists — mints a token + sends mail, no profile-owned data",
  },
  {
    file: "app/(auth)/set-password/actions.ts",
    fn: "completeSetPassword",
    why: "public auth entry point (issue #985); consumes a single-use invite/reset token to set the login's OWN password, runs before any session exists — no profile-owned data",
  },
  // --- Thin wrappers that delegate to a gated helper ---
  {
    file: "app/(app)/actions.ts",
    fn: "dismissDataQualityGap",
    why: "delegates to dismissCoachingObservation(), which calls requireWriteAccess() (#1219 named alias so the two widgets can diverge safely)",
  },
  {
    file: "app/(app)/encounters/appointment-actions.ts",
    fn: "completeAppointment",
    why: "delegates to setStatus(), which calls requireWriteAccess()",
  },
  {
    file: "app/(app)/encounters/appointment-actions.ts",
    fn: "cancelAppointment",
    why: "delegates to setStatus(), which calls requireWriteAccess()",
  },
  {
    file: "app/(app)/encounters/appointment-actions.ts",
    fn: "reopenAppointment",
    why: "delegates to setStatus(), which calls requireWriteAccess()",
  },
  // --- Cross-profile / session-pointer actions (gate the TARGET, not the active
  // profile, so requireWriteAccess() would check the wrong profile) ---
  {
    file: "app/(app)/household/actions.ts",
    fn: "openProfileAction",
    why: "moves the session's active-profile pointer (setActiveProfile re-checks accessibility); not a write to profile-owned data, and read-only members must still be able to switch profiles",
  },
  {
    file: "app/(app)/household/actions.ts",
    fn: "confirmDoseAction",
    why: "acts on a NON-active target profile; gates via requireProfileWriteAccess(targetId), which asserts the target is accessible AND write — the active-profile requireWriteAccess() would authorize the wrong profile",
  },
  {
    file: "app/(app)/household/actions.ts",
    fn: "undoConfirmDoseAction",
    why: "the #2642 inverse of confirmDoseAction and exempt for the identical reason: it acts on the NON-active target profile the form names and gates via requireProfileWriteAccess(targetId), so a read-only caregiver can no more un-log a member's dose than log it",
  },
  {
    file: "app/(app)/household/actions.ts",
    fn: "openMemberSetupAction",
    why: "navigation only (#2173): moves the session's active-profile pointer to the card's member and redirects to a route RE-DERIVED server-side from the check id, never posted; gated read-level on getAccessibleProfiles() before any of that member's facts are read, because a read-only caregiver must still be able to follow a setup CTA",
  },
  {
    file: "app/(app)/household/actions.ts",
    fn: "dismissMemberSetupAction",
    why: "silences a finding about a NON-active target profile (#2173); gates via requireProfileWriteAccess(targetId) — the active-profile requireWriteAccess() would authorize the wrong profile — and additionally refuses any row the pure model marks non-dismissible, so an unroutable member can never be silenced",
  },
  // --- Shared supply pools (issue #1374) — a `shared_supplies` row is household-
  // shared and has NO owning profile, so the active-profile requireWriteAccess()
  // would authorize the wrong subject. Pool EDITS gate on the pool's MEMBERSHIP
  // (requirePoolWriteAccess: write access to ≥1 linked profile, falling back to
  // requireProfileWriteAccess for the refusal path, and to requireWriteAccess for an
  // orphaned pool that links nobody); LINK/UNLINK gate on the ITEM's own profile
  // (requireItemWriteAccess → requireProfileWriteAccess). ---
  {
    file: "app/(app)/results/actions.ts",
    fn: "loadBiomarkerPanelRows",
    why: "read-only (#1651): returns ONE panel group's readings when the reader expands it, so the Biomarkers index can ship a bounded payload instead of every reading up front; writes nothing, and it re-resolves requireScope() and re-parses the URL filters with the same helpers the page used, so it can only return rows that reader's own page render would have shown",
  },
  {
    file: "app/(app)/supplies/actions.ts",
    fn: "listSharedSupplyOptions",
    why: "read-only (#1374): lists the shared bottles the caller's accessible profiles already draw from (plus member-less orphans) for the item form's picker; writes nothing, so the requireScope()/requireSession() boundary is the right gate",
  },
  {
    file: "app/(app)/supplies/actions.ts",
    fn: "updatePoolAction",
    why: "#1374: edits a household-shared pool with no owning profile; gates via requirePoolWriteAccess(poolId) → write access to at least ONE linked profile (requireProfileWriteAccess on the refusal path)",
  },
  {
    file: "app/(app)/supplies/actions.ts",
    fn: "deletePoolAction",
    why: "#1374: deletes a household-shared pool; same requirePoolWriteAccess(poolId) membership gate as updatePoolAction",
  },
  {
    file: "app/(app)/supplies/actions.ts",
    fn: "linkItemAction",
    why: "#1374: links a NON-active profile's item into a shared bottle; gates via requireItemWriteAccess(itemId) → requireProfileWriteAccess(itemProfileId), so the item's own profile authorizes it",
  },
  {
    file: "app/(app)/supplies/actions.ts",
    fn: "unlinkItemAction",
    why: "#1374: unlinks the ITEM's row from its pool; same requireItemWriteAccess(itemId) → requireProfileWriteAccess(itemProfileId) gate as linkItemAction",
  },
  // --- Multi-view Upcoming per-item writes (issue #1096) — each row carries its
  // OWN profileId, so the write must target the ITEM's profile, not the acting one.
  // All gate through the shared gateItemProfile() helper, which calls
  // requireProfileWriteAccess(itemProfileId) (a read-only-granted / ungranted member
  // is bounced) and falls back to requireWriteAccess() for a single-view form. ---
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "markTaken",
    why: "multi-view (#1096): confirms a dose on the ITEM's row; gateItemProfile() → requireProfileWriteAccess(itemProfileId), so Sam's dose writes to Sam even while acting as someone else",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "markPreventiveDone",
    why: "multi-view (#1096): records a preventive satisfaction on the ITEM's profile via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "markCarePlanDone",
    why: "multi-view (#1096): completes a care-plan item on the ITEM's profile via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "overridePreventive",
    why: "multi-view (#1096): overrides a preventive rule on the ITEM's profile via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "resolveFollowUp",
    why: "multi-view (#1096): resolves a follow-up on the ITEM's profile via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "settleFollowUp",
    why: "multi-view (#1096): settles (done/declined, #1866 terminator) a follow-up on the ITEM's profile via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "snoozeItem",
    why: "multi-view (#1096): snoozes on the ITEM's suppression bus via gateItemProfile() → requireProfileWriteAccess(itemProfileId), so a dismissal lands on the item's profile, never the acting one",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "dismissItem",
    why: "multi-view (#1096): dismisses on the ITEM's suppression bus via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/upcoming/actions.ts",
    fn: "restoreItem",
    why: "multi-view (#1096): restores on the ITEM's suppression bus via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  // --- Tier-1 multi-view record-list edits/deletes (issue #1328) — each row carries
  // its OWN profileId, so an edit/delete on a non-acting member's row must target the
  // ROW's profile, not the acting one. All gate through the shared gateItemProfile()
  // helper (app/(app)/gate-item.ts), which calls requireProfileWriteAccess(itemProfileId)
  // (a read-only-granted / ungranted member is bounced) and falls back to
  // requireWriteAccess() for a single-view form. The paired add* action keeps its plain
  // requireWriteAccess() (a new row always lands on the acting profile). ---
  {
    file: "app/(app)/records/problems/conditions/actions.ts",
    fn: "updateCondition",
    why: "multi-view (#1328): edits the ITEM's condition via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/problems/conditions/actions.ts",
    fn: "deleteCondition",
    why: "multi-view (#1328): deletes the ITEM's condition via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/problems/allergies/actions.ts",
    fn: "updateAllergy",
    why: "multi-view (#1328): edits the ITEM's allergy via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/problems/allergies/actions.ts",
    fn: "deleteAllergy",
    why: "multi-view (#1328): deletes the ITEM's allergy via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/history/procedures/actions.ts",
    fn: "updateProcedure",
    why: "multi-view (#1328): edits the ITEM's procedure via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/history/procedures/actions.ts",
    fn: "deleteProcedure",
    why: "multi-view (#1328): deletes the ITEM's procedure via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/care/overview/family-history-actions.ts",
    fn: "updateFamilyHistory",
    why: "multi-view (#1328): edits the ITEM's family-history entry via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/care/overview/family-history-actions.ts",
    fn: "deleteFamilyHistory",
    why: "multi-view (#1328): deletes the ITEM's family-history entry via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/care/overview/care-plan-actions.ts",
    fn: "updateCarePlanItem",
    why: "multi-view (#1328): edits the ITEM's care-plan item via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/care/overview/care-plan-actions.ts",
    fn: "deleteCarePlanItem",
    why: "multi-view (#1328): deletes the ITEM's care-plan item via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/care/overview/care-goal-actions.ts",
    fn: "updateCareGoal",
    why: "multi-view (#1328): edits the ITEM's health goal via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/care/overview/care-goal-actions.ts",
    fn: "deleteCareGoal",
    why: "multi-view (#1328): deletes the ITEM's health goal via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/results/genomics/actions.ts",
    fn: "updateGenomicVariant",
    why: "multi-view (#1328): edits the ITEM's genomic variant via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/results/genomics/actions.ts",
    fn: "deleteGenomicVariant",
    why: "multi-view (#1328): deletes the ITEM's genomic variant via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/results/imaging/actions.ts",
    fn: "updateImagingStudy",
    why: "multi-view (#1328): edits the ITEM's imaging study via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/results/imaging/actions.ts",
    fn: "deleteImagingStudy",
    why: "multi-view (#1328): deletes the ITEM's imaging study via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  // --- The Specialty panes joined the same fan-out in #2557. Their lists used to be
  // acting-profile-only, which is why the issue's title reads as a hazard rather than
  // a live defect: nothing was listed that could not be edited. Converting them to
  // multi-view is what CREATES that hazard, so the per-item gate lands in the same
  // change. addDentalProcedure / addOpticalPrescription / trackDentalFollowUp keep
  // their plain requireWriteAccess() — a new record, and the recheck follow-up, land
  // on the acting profile by design. ---
  {
    file: "app/(app)/records/specialty/dental/actions.ts",
    fn: "updateDentalProcedure",
    why: "multi-view (#2557): edits the ITEM's dental record via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/specialty/dental/actions.ts",
    fn: "deleteDentalProcedure",
    why: "multi-view (#2557): deletes the ITEM's dental record — and unlinks its follow-ups on that same profile — via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/specialty/vision/actions.ts",
    fn: "updateOpticalPrescription",
    why: "multi-view (#2557): edits the ITEM's optical prescription via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/records/specialty/vision/actions.ts",
    fn: "deleteOpticalPrescription",
    why: "multi-view (#2557): deletes the ITEM's optical prescription via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  // --- Multi-view Readings table edits/deletes (issue #1331). Each merged row
  // carries its OWN profileId, so an edit/delete on a non-acting member's reading
  // targets the ROW's profile via gateItemProfile() → requireProfileWriteAccess. The
  // paired addResult keeps its plain requireWriteAccess() (a new reading always lands
  // on the acting profile). ---
  {
    file: "app/(app)/results/reading-actions.ts",
    fn: "updateResult",
    why: "multi-view (#1331): edits the ITEM's biomarker reading via gateItemProfile() → requireProfileWriteAccess(itemProfileId); the document subpage form posts no profile_id and falls back to the acting-profile gate",
  },
  {
    file: "app/(app)/results/reading-actions.ts",
    fn: "deleteResult",
    why: "multi-view (#1331): deletes the ITEM's biomarker reading via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  // --- Multi-view Training Log writes (issue #1330). A merged card carries its
  // subject's profile_id, so the save/delete/merge target the SUBJECT's profile via
  // the shared gateItemProfile() → requireProfileWriteAccess(itemProfileId) (a
  // read-only-granted / ungranted member is bounced). No profile_id (a CREATE, or a
  // single-view form) falls back to requireWriteAccess() on the acting profile. ---
  {
    file: "app/(app)/training/activity-actions.ts",
    fn: "saveActivity",
    why: "multi-view (#1330): creates on the acting profile, or edits the ITEM's activity on its subject profile, via gateItemProfile() → requireProfileWriteAccess(itemProfileId); login is read only for the viewer's unit prefs",
  },
  {
    file: "app/(app)/training/activity-actions.ts",
    fn: "deleteActivity",
    why: "multi-view (#1330): deletes the ITEM's activity on its subject profile via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/training/activity-actions.ts",
    fn: "mergeActivities",
    why: "multi-view (#1330): folds a same-profile same-day pair on the ITEM's subject profile via gateItemProfile() → requireProfileWriteAccess(itemProfileId); cross-profile pairs are refused by the AND profile_id re-check",
  },
  // --- Tier-1b bespoke lists (issue #1359) — the flat SUB-lists of the Visits and
  // Immunizations surfaces adopt multi-view (Past encounters / All recorded doses);
  // their edit/delete gate the ROW's own profile through the same gateItemProfile()
  // helper. The surrounding acting-only apparatus (appointment booking, the age-derived
  // schedule assessment) is untouched, and the add* actions keep plain
  // requireWriteAccess(). ---
  {
    file: "app/(app)/encounters/actions.ts",
    fn: "updateEncounter",
    why: "multi-view (#1359): edits the ITEM's visit via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/encounters/actions.ts",
    fn: "deleteEncounter",
    why: "multi-view (#1359): deletes the ITEM's visit via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/immunizations/actions.ts",
    fn: "updateImmunization",
    why: "multi-view (#1359): edits the ITEM's immunization dose via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
  {
    file: "app/(app)/immunizations/actions.ts",
    fn: "deleteImmunization",
    why: "multi-view (#1359): deletes the ITEM's immunization dose via gateItemProfile() → requireProfileWriteAccess(itemProfileId)",
  },
];

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

// Every Server-Action module: any file whose name ends in `actions.ts`
// (`actions.ts` and the `*-actions.ts` variants), minus tests.
function actionFiles(): string[] {
  const all: string[] = [];
  walk(path.join(REPO, "app"), all);
  return all.filter((f) => {
    if (!f.endsWith("actions.ts")) return false;
    if (f.endsWith(".test.ts")) return false;
    return true;
  });
}

// Route handlers are request boundaries too. The original #33 scan stopped at
// `*actions.ts`, which left every `route.ts` outside the write-access ratchet even
// when it called the same auth-blind cores. Keep the two inventories separate: an
// action has the repo-wide default gate, while a route can authenticate through a
// session, bearer token, webhook secret, or a deliberately composed profile gate.
function routeFiles(): string[] {
  const all: string[] = [];
  walk(path.join(REPO, "app"), all);
  return all.filter(
    (f) => f.endsWith(`${path.sep}route.ts`) && !f.endsWith(".test.ts")
  );
}

type RegisteredImports = Readonly<Record<string, readonly string[]>>;

// Resolve the LOCAL names for registered named imports, including aliases. This
// keeps the scans below tied to the module that owns a core: a local helper with the
// same spelling cannot be mistaken for a write, and `foo as fooCore` cannot evade it.
function registeredImportLocals(
  src: string,
  registered: RegisteredImports
): Map<string, string> {
  const out = new Map<string, string>();
  const sf = ts.createSourceFile(
    "scan.ts",
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const allowed = registered[statement.moduleSpecifier.text];
    if (!allowed) continue;
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const element of named.elements) {
      if (element.isTypeOnly) continue;
      const imported = element.propertyName?.text ?? element.name.text;
      if (allowed.includes(imported)) out.set(element.name.text, imported);
    }
  }
  return out;
}

function callIndexes(
  body: string,
  names: Iterable<string>
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const name of names) {
    const hits: number[] = [];
    const re = new RegExp(`\\b${name}\\s*\\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(body))) hits.push(match.index);
    out.set(name, hits);
  }
  return out;
}

// The route-facing auth-blind cores currently reachable from request handlers.
// This is symbol-level, not module-level: several of these modules also export
// reads, and treating every import from (say) lib/portals as a write would turn the
// guard into an allowlist of harmless lookups. A new route call to one of these
// cores is covered automatically; a new route-facing core is registered here as
// part of introducing that boundary, like STATEFUL_WRITE_TABLES.
const ROUTE_WRITE_CORES: RegisteredImports = {
  "@/lib/audit": ["recordAudit"],
  "@/lib/medical-pipeline": ["ingestMedicalUpload"],
  "@/lib/portals": [
    "applyIdentityOutcomes",
    "clearIdentityDeclined",
    "recordDiscoveredIdentities",
    "recordPendingIdentity",
    "recordPortalRunReport",
  ],
  "@/lib/integrations/connections": [
    "recordSync",
    "recordSyncEvent",
    "recordSyncRows",
    "recordUnmatchedHealthConnectPush",
    "setStravaTokens",
    "setWithingsTokens",
    "takeStravaOAuthState",
    "takeWithingsOAuthState",
    "upsertConnection",
  ],
  "@/lib/offline/writes": ["applyIntent"],
  "@/lib/notifications/telegram-callbacks": [
    "handleCallbackQuery",
    "handleIncomingMessage",
  ],
  "@/lib/integrations/fitbit-takeout-import": ["importTakeoutArchive"],
  "@/lib/integrations/health-connect-ingest": ["ingestHealthConnectPayload"],
  "@/lib/integrations/raw-log": ["writeRawPayload"],
  "@/lib/notifications/temp-red-flag": ["queueTempRedFlagDispatch"],
  "@/lib/queries": ["addCanonicalNames", "reconcileFlags"],
  "@/lib/settings": ["setProfileSex"],
};

type RouteGate = {
  file: string;
  fn: string;
  gates: readonly string[];
  why: string;
};

// The gate whose call must precede the FIRST registered write in each route
// handler. These are deliberately route-specific: accepting authenticateApiToken
// for sync-report would re-introduce #2105, because the missing check there was the
// account write-set intersection (`canReportOnAccount`), not token presence.
const ROUTE_GATES: readonly RouteGate[] = [
  {
    file: "app/share-target/route.ts",
    fn: "POST",
    gates: ["accessForProfile"],
    why: "the browser share target composes the active-profile write gate explicitly so it can answer JSON/303 rather than throw a Server Action redirect",
  },
  {
    file: "app/api/documents/route.ts",
    fn: "POST",
    gates: ["authenticateApiToken"],
    why: "remote uploads require an upload-capable bearer before even an unmapped portal identity may be recorded; resolved uploads add the profile write-set intersection below",
  },
  {
    file: "app/api/documents/sync-report/route.ts",
    fn: "POST",
    gates: ["canReportOnAccount"],
    why: "#2105: the token must intersect the portal account's writable profiles before discovered identities, outcomes, or account run state are written",
  },
  {
    file: "app/api/offline-replay/route.ts",
    fn: "POST",
    gates: ["accessForProfile"],
    why: "each queued intent is intersected with the login's current write grant for its captured profile before applyIntent",
  },
  {
    file: "app/api/integrations/fitbit-takeout/import/route.ts",
    fn: "POST",
    gates: ["requireWriteAccess"],
    why: "the archive imports into the active profile under the ordinary Server Action write gate",
  },
  {
    file: "app/api/integrations/health-connect/ingest/route.ts",
    fn: "POST",
    gates: ["resolveHealthConnectProfile"],
    why: "the per-profile bearer is resolved before any attributable raw payload, sync event, or normalized record is written",
  },
  {
    file: "app/api/integrations/strava/callback/route.ts",
    fn: "GET",
    gates: ["getCurrentSession"],
    why: "OAuth state and tokens are profile-owned by the callback's live session",
  },
  {
    file: "app/api/integrations/withings/callback/route.ts",
    fn: "GET",
    gates: ["getCurrentSession"],
    why: "OAuth state and tokens are profile-owned by the callback's live session",
  },
  {
    file: "app/api/telegram/webhook/route.ts",
    fn: "POST",
    gates: ["secretMatches"],
    why: "the configured Telegram webhook secret authenticates the inbound callback before any command/tap handler runs",
  },
  {
    file: "app/api/export/[dataset]/route.ts",
    fn: "GET",
    gates: ["getCurrentSession"],
    why: "the audit row records an authenticated profile export",
  },
  {
    file: "app/api/export/fhir/route.ts",
    fn: "GET",
    gates: ["getCurrentSession"],
    why: "the audit row records an authenticated profile export",
  },
  {
    file: "app/api/export/full/route.ts",
    fn: "GET",
    gates: ["getCurrentSession"],
    why: "the audit row records an authenticated profile export",
  },
];

// Media routes must resolve the row first to learn which profile to authorize, then
// record the access audit. Their gates are deliberately bespoke combinations of
// session + row ownership/reachability, so they are the named #1696-style exception
// rather than pretending one generic call proves the whole sequence.
const ROUTE_WRITE_ALLOW: readonly {
  file: string;
  fn: string;
  core: string;
  why: string;
}[] = [
  "app/(app)/medical/file/[id]/route.ts",
  "app/api/activity-video/[id]/route.ts",
  "app/api/lesion-photo/[id]/route.ts",
  "app/api/progress-photo/[id]/route.ts",
  "app/api/symptom-photo/[id]/route.ts",
  "app/api/symptom-video/[id]/route.ts",
].map((file) => ({
  file,
  fn: "GET",
  core: "recordAudit",
  why: "resolve-owner-then-gate media read (#1696): the row supplies profile_id, the handler checks the live session against that owner, and only then records the audit event",
}));

const TYPED_OUTCOME_CORES: RegisteredImports = {
  "@/lib/appointment-status": ["setAppointmentStatus"],
  "@/lib/cycle-write": ["startPeriodCore", "endPeriodCore", "reopenPeriodCore"],
  "@/lib/illness-episode-write": [
    "promoteEpisodeToConditionCore",
    "endEpisodeCore",
    "reopenEpisodeCore",
    "endEpisodeAsOfCore",
    "endEpisodeWithMedReconciliation",
  ],
  // The app boundary consumes these through the compatibility barrel; aliases
  // such as `logHistoricalDose as logHistoricalDoseCore` are resolved above.
  "@/lib/queries": [
    "refillSupply",
    "markDoseTaken",
    "setDoseStatusCore",
    "logAdministration",
    "logHistoricalDose",
    "updateHistoricalDose",
    "deleteAdministrationLog",
    "stopMedicationCourses",
    "restartMedicationCourse",
    "setMedicationEndDate",
    "setMedicationSideEffectResolved",
    "unretireDose",
  ],
  "@/lib/intake-active-write": ["setIntakeActive"],
  "@/lib/intake-obligation-write": ["demoteIntakeObligation"],
  "@/lib/equipment": ["setEquipmentRetired", "deleteEquipment"],
};

// The portal binding upsert literally carries `DO UPDATE SET profile_id`. Every
// action that reaches it is therefore declared: either it takes two profile-write
// gates for a possible re-point, or it proves why one side cannot exist and relies
// on writeBinding's in-transaction refusal as the race backstop.
const PROFILE_REPOINT_ACTIONS: readonly {
  file: string;
  fn: string;
  core: "bindPortalIdentity" | "remapPortalIdentity";
  minGates: number;
  why: string;
}[] = [
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "bindIdentityAction",
    core: "bindPortalIdentity",
    minGates: 1,
    why: "the possible re-point branches to remapPortalIdentity above; the remaining bind/idempotent path gates its target and writeBinding refuses a raced live binding in-transaction",
  },
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "bindIdentityAction",
    core: "remapPortalIdentity",
    minGates: 2,
    why: "the re-point branch routes records away from one profile and onto another",
  },
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "remapIdentityAction",
    core: "remapPortalIdentity",
    minGates: 2,
    why: "Change profile is explicitly a two-sided access-control transition",
  },
  {
    file: "app/(app)/integrations/patient-portals/actions.ts",
    fn: "bindPendingIdentityAction",
    core: "bindPortalIdentity",
    minGates: 1,
    why: "the source is an unmapped pending identity; writeBinding refuses a raced live binding inside the write transaction, so only the target exists to gate",
  },
];

// Strip comments so a stray mention of the guard name in prose can't satisfy the
// check — only a real call in code counts. Block comments first, then whole-line
// `//` comments (the only place these files park explanatory text). Leaves string
// literals intact; the token we scan for (`requireWriteAccess(`) never appears in
// a user-facing string.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

// Extract every exported async function as { name, body }. Balanced-brace scan
// from the function's opening `{` to its matching `}`.
function exportedAsyncFunctions(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    // Walk to the end of the parameter list, then to the body's opening brace.
    let i = m.index + m[0].length;
    let depth = 1; // we're just past the '('
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    // Skip a return-type annotation up to the body's opening '{', ignoring any
    // '{' nested inside a <...> generic — e.g. `: Promise<{ ok: true }>`, whose
    // object brace must NOT be mistaken for the function body.
    let angle = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "<") angle++;
      else if (c === ">") {
        if (angle > 0) angle--;
      } else if (c === "{" && angle === 0) break;
      i++;
    }
    if (src[i] !== "{") continue;
    let bdepth = 1;
    let j = i + 1;
    let body = "";
    while (j < src.length && bdepth > 0) {
      const c = src[j];
      if (c === "{") bdepth++;
      else if (c === "}") {
        bdepth--;
        if (bdepth === 0) break;
      }
      body += c;
      j++;
    }
    out.push({ name, body });
    re.lastIndex = j + 1;
  }
  return out;
}

const GATE_RE = /\b(requireWriteAccess|requireAdmin)\s*\(/;

function routeWriteScan(
  rel: string,
  src: string
): {
  violations: string[];
  matchedGates: Set<string>;
  matchedAllow: Set<string>;
  reachedCores: Set<string>;
} {
  const violations: string[] = [];
  const matchedGates = new Set<string>();
  const matchedAllow = new Set<string>();
  const reachedCores = new Set<string>();
  const imports = registeredImportLocals(src, ROUTE_WRITE_CORES);
  const code = stripComments(src);

  for (const { name, body } of exportedAsyncFunctions(code)) {
    if (!/^(?:GET|POST|PUT|PATCH|DELETE)$/.test(name)) continue;
    const writes: { local: string; core: string; index: number }[] = [];
    const indexes = callIndexes(body, imports.keys());
    for (const [local, core] of imports) {
      for (const index of indexes.get(local) ?? []) {
        writes.push({ local, core, index });
        reachedCores.add(core);
      }
    }
    if (writes.length === 0) continue;

    const gate = ROUTE_GATES.find((g) => g.file === rel && g.fn === name);
    const gateIndexes = gate
      ? [...callIndexes(body, gate.gates).values()].flat()
      : [];
    const firstGate =
      gateIndexes.length > 0
        ? Math.min(...gateIndexes)
        : Number.POSITIVE_INFINITY;

    for (const write of writes) {
      const allow = ROUTE_WRITE_ALLOW.find(
        (a) => a.file === rel && a.fn === name && a.core === write.core
      );
      if (allow) {
        matchedAllow.add(`${allow.file}#${allow.fn}#${allow.core}`);
        continue;
      }
      if (!gate) {
        violations.push(
          `${rel}#${name}: reaches mutating core ${write.core}(…) without a registered route gate — declare the request boundary and require it before the first write`
        );
        continue;
      }
      if (firstGate >= write.index) {
        violations.push(
          `${rel}#${name}: ${write.core}(…) runs before its registered gate (${gate.gates.join(
            " / "
          )}) — authorize before the first write core call`
        );
        continue;
      }
      matchedGates.add(`${gate.file}#${gate.fn}`);
    }
  }
  return { violations, matchedGates, matchedAllow, reachedCores };
}

function discardedOutcomeCalls(
  body: string,
  imports: ReadonlyMap<string, string>
): string[] {
  const bad: string[] = [];
  for (const [local, core] of imports) {
    const re = new RegExp(`\\b${local}\\s*\\(`, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(body))) {
      let before = body.slice(0, match.index).replace(/\s+$/, "");
      while (/\bawait$/.test(before)) {
        before = before.slice(0, -"await".length).replace(/\s+$/, "");
      }
      const ch = before.at(-1) ?? "";
      // A call reached through assignment, return, an argument, a condition, or an
      // expression consumes the value. Statement position consumes nothing.
      if (ch === "" || ch === ";" || ch === "{" || ch === "}" || ch === ")") {
        bad.push(core);
      }
    }
  }
  return bad;
}

const PROFILE_REPOINT_CORES: RegisteredImports = {
  "@/lib/portals": ["bindPortalIdentity", "remapPortalIdentity"],
};

const PROFILE_REPOINT_SQL_ALLOW = [
  {
    file: "lib/notifications/message-pointers.ts",
    why: "delivery bookkeeping, not a profile-routing decision: the key is the Telegram (chat_id, message_id) pair being replaced by the newly-sent message's declared profile in the same outbound operation; no existing health row changes owner",
  },
] as const;

function profileRepointScan(
  rel: string,
  src: string
): {
  violations: string[];
  matched: Set<string>;
} {
  const violations: string[] = [];
  const matched = new Set<string>();
  const imports = registeredImportLocals(src, PROFILE_REPOINT_CORES);
  const code = stripComments(src);
  for (const { name, body } of exportedAsyncFunctions(code)) {
    const indexes = callIndexes(body, imports.keys());
    for (const [local, core] of imports) {
      const coreCalls = indexes.get(local) ?? [];
      if (coreCalls.length === 0) continue;
      const declaration = PROFILE_REPOINT_ACTIONS.find(
        (entry) =>
          entry.file === rel && entry.fn === name && entry.core === core
      );
      if (!declaration) {
        violations.push(
          `${rel}#${name}: calls profile-repointing core ${core}(…) without declaring whether both profile sides are gated`
        );
        continue;
      }
      matched.add(`${declaration.file}#${declaration.fn}#${declaration.core}`);
      for (const call of coreCalls) {
        const gatesBeforeCall =
          body.slice(0, call).match(/\brequireProfileWriteAccess\s*\(/g)
            ?.length ?? 0;
        if (gatesBeforeCall < declaration.minGates) {
          violations.push(
            `${rel}#${name}: ${core}(…) declares ${declaration.minGates} profile-write gate(s) before the transition but has ${gatesBeforeCall}`
          );
        }
      }
    }
  }
  return { violations, matched };
}

describe("write-access enforcement: every mutating Server Action is gated", () => {
  const files = actionFiles();

  it("scans a meaningful number of action files", () => {
    // Guards against a broken glob silently passing the whole suite.
    expect(files.length).toBeGreaterThan(25);
  });

  it("every exported action calls requireWriteAccess()/requireAdmin() or is allowlisted", () => {
    const violations: string[] = [];
    const matchedAllow = new Set<string>();
    const matchedModules = new Set<string>();
    let scanned = 0;

    for (const file of files) {
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      const src = stripComments(fs.readFileSync(file, "utf8"));
      const moduleAllow = MODULE_ALLOW.find((entry) => entry.file === rel);
      for (const { name, body } of exportedAsyncFunctions(src)) {
        scanned++;
        if (GATE_RE.test(body)) continue; // write-gated (or admin-gated)
        const allow = ALLOW.find((a) => a.file === rel && a.fn === name);
        if (allow) {
          matchedAllow.add(`${allow.file}#${allow.fn}`);
          // A demo-gated login-scoped mutation (#278) must actually call its
          // declared guard — the allowlist exemption alone is not enough.
          if (allow.gate && !new RegExp(`\\b${allow.gate}\\s*\\(`).test(body)) {
            violations.push(
              `${rel}#${name}: allowlisted with gate "${allow.gate}" but the body never calls it — the demo-mode guard regressed`
            );
          }
          continue;
        }
        if (moduleAllow) {
          matchedModules.add(moduleAllow.file);
          const gated = moduleAllow.gates.some((gate) =>
            new RegExp(`\\b${gate}\\s*\\(`).test(body)
          );
          if (!gated) {
            violations.push(
              `${rel}#${name}: module-scoped exemption requires ${moduleAllow.gates.join(" or ")}`
            );
          }
          continue;
        }
        violations.push(
          `${rel}#${name}: mutating action missing requireWriteAccess() — add the guard, or allowlist it with a justification if it is a read/login-scoped/admin/delegating action`
        );
      }
    }

    // The scan must actually see the whole action surface.
    expect(scanned).toBeGreaterThan(70);
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);

    // No stale allowlist entries: every exemption must correspond to a real
    // exported action still present (a renamed/removed action must drop its entry
    // so the list can't rot into a silent hole).
    const stale = ALLOW.filter(
      (a) => !matchedAllow.has(`${a.file}#${a.fn}`)
    ).map((a) => `${a.file}#${a.fn}`);
    expect(stale, `stale allowlist entries: ${stale.join(", ")}`).toEqual([]);

    const staleModules = MODULE_ALLOW.filter(
      (entry) => !matchedModules.has(entry.file)
    ).map((entry) => entry.file);
    expect(
      staleModules,
      `stale module allowlist entries: ${staleModules.join(", ")}`
    ).toEqual([]);
  });
});

describe("route write-access enforcement (#2109)", () => {
  const files = routeFiles();

  it("scans the route-handler surface", () => {
    expect(files.length).toBeGreaterThan(25);
  });

  it("runs the registered route gate before the first mutating core", () => {
    const violations: string[] = [];
    const matchedGates = new Set<string>();
    const matchedAllow = new Set<string>();
    const reachedCores = new Set<string>();
    for (const file of files) {
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      const result = routeWriteScan(rel, fs.readFileSync(file, "utf8"));
      violations.push(...result.violations);
      result.matchedGates.forEach((entry) => matchedGates.add(entry));
      result.matchedAllow.forEach((entry) => matchedAllow.add(entry));
      result.reachedCores.forEach((entry) => reachedCores.add(entry));
    }
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);

    const staleGates = ROUTE_GATES.filter(
      (entry) => !matchedGates.has(`${entry.file}#${entry.fn}`)
    ).map((entry) => `${entry.file}#${entry.fn}`);
    expect(staleGates, `stale route gates: ${staleGates.join(", ")}`).toEqual(
      []
    );

    const staleAllow = ROUTE_WRITE_ALLOW.filter(
      (entry) => !matchedAllow.has(`${entry.file}#${entry.fn}#${entry.core}`)
    ).map((entry) => `${entry.file}#${entry.fn}#${entry.core}`);
    expect(staleAllow, `stale route allows: ${staleAllow.join(", ")}`).toEqual(
      []
    );

    // Every registered symbol is exercised by a real route today. If a route stops
    // calling it, remove the entry; a stale mega-registry is not an enforcement tool.
    const registeredCores = new Set(Object.values(ROUTE_WRITE_CORES).flat());
    const staleCores = [...registeredCores].filter(
      (core) => !reachedCores.has(core)
    );
    expect(
      staleCores,
      `stale route write cores: ${staleCores.join(", ")}`
    ).toEqual([]);
  });

  it("FLAGS the #2105 write-before-gate shape", () => {
    const planted = `
      import { recordDiscoveredIdentities } from "@/lib/portals";
      import { canReportOnAccount } from "@/lib/portal-visibility";
      export async function POST() {
        recordDiscoveredIdentities(account, labels);
        if (!canReportOnAccount(ids, true, account.id)) return new Response(null, { status: 404 });
        return Response.json({ ok: true });
      }
    `;
    const result = routeWriteScan(
      "app/api/documents/sync-report/route.ts",
      planted
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain("runs before its registered gate");
  });
});

describe("profile re-points declare both authorization sides (#2103/#2109)", () => {
  it("discovers every runtime module with a profile-repointing upsert", () => {
    const files: string[] = [];
    walk(path.join(REPO, "lib"), files);
    const upserts = files
      .filter(
        (file) =>
          file.endsWith(".ts") &&
          !file.includes(`${path.sep}__tests__${path.sep}`) &&
          !file.includes(`${path.sep}__db_tests__${path.sep}`) &&
          !file.includes(`${path.sep}__action_tests__${path.sep}`) &&
          !file.includes(`${path.sep}migrations${path.sep}`)
      )
      .filter((file) =>
        /\bDO\s+UPDATE\s+SET\s+profile_id\s*=/i.test(
          fs.readFileSync(file, "utf8")
        )
      )
      .map((file) => path.relative(REPO, file).split(path.sep).join("/"));
    const registeredModules = new Set(
      Object.keys(PROFILE_REPOINT_CORES).map(
        (module) => `${module.replace(/^@\//, "")}.ts`
      )
    );
    const unregistered = upserts.filter(
      (file) =>
        !registeredModules.has(file) &&
        !PROFILE_REPOINT_SQL_ALLOW.some((entry) => entry.file === file)
    );
    expect(
      unregistered,
      `profile-repointing upserts missing a caller/gate declaration: ${unregistered.join(", ")}`
    ).toEqual([]);
    expect(upserts.length).toBeGreaterThan(0);
    const staleAllow = PROFILE_REPOINT_SQL_ALLOW.filter(
      (entry) => !upserts.includes(entry.file)
    ).map((entry) => entry.file);
    expect(
      staleAllow,
      `stale profile-repoint SQL allows: ${staleAllow.join(", ")}`
    ).toEqual([]);
  });

  it("every action reaching a re-point-capable core declares and takes its gates", () => {
    const violations: string[] = [];
    const matched = new Set<string>();
    for (const file of actionFiles()) {
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      const result = profileRepointScan(rel, fs.readFileSync(file, "utf8"));
      violations.push(...result.violations);
      result.matched.forEach((entry) => matched.add(entry));
    }
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);

    const stale = PROFILE_REPOINT_ACTIONS.filter(
      (entry) => !matched.has(`${entry.file}#${entry.fn}#${entry.core}`)
    ).map((entry) => `${entry.file}#${entry.fn}#${entry.core}`);
    expect(
      stale,
      `stale profile re-point declarations: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("FLAGS a one-sided action calling a re-point core", () => {
    const planted = `
      import { remapPortalIdentity } from "@/lib/portals";
      export async function remapIdentityAction() {
        await requireProfileWriteAccess(targetProfileId);
        return remapPortalIdentity(id, ownerProfileId, targetProfileId);
      }
    `;
    const result = profileRepointScan(
      "app/(app)/integrations/patient-portals/actions.ts",
      planted
    );
    expect(result.violations).toEqual([
      expect.stringContaining(
        "declares 2 profile-write gate(s) before the transition but has 1"
      ),
    ]);
  });
});

describe("actions consume typed write-core outcomes (#2106/#2109)", () => {
  it("no action discards a registered typed outcome in statement position", () => {
    const violations: string[] = [];
    const reached = new Set<string>();
    for (const file of actionFiles()) {
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      const src = fs.readFileSync(file, "utf8");
      const imports = registeredImportLocals(src, TYPED_OUTCOME_CORES);
      for (const core of imports.values()) reached.add(core);
      for (const { name, body } of exportedAsyncFunctions(stripComments(src))) {
        for (const core of discardedOutcomeCalls(body, imports)) {
          violations.push(
            `${rel}#${name}: ${core}(…) is called as a bare statement — consume its typed outcome and return/render the refusal instead of confirming unconditionally`
          );
        }
      }
    }
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);

    const registered = new Set(Object.values(TYPED_OUTCOME_CORES).flat());
    const stale = [...registered].filter((core) => !reached.has(core));
    expect(
      stale,
      `typed outcome cores unused by actions: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("FLAGS bare awaited calls and accepts captured or returned outcomes", () => {
    const imports = new Map([["markTaken", "markDoseTaken"]]);
    expect(discardedOutcomeCalls("await markTaken(1);", imports)).toEqual([
      "markDoseTaken",
    ]);
    expect(
      discardedOutcomeCalls("const outcome = await markTaken(1);", imports)
    ).toEqual([]);
    expect(discardedOutcomeCalls("return markTaken(1);", imports)).toEqual([]);
  });
});
