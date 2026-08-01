// WHERE A HOUSEHOLD IS IN PATIENT-PORTAL SETUP (issue #1826) — one pure function.
//
// #1739 shipped the whole machinery and the page rendered ALL of it, always: eight flat
// sibling cards, five empty states in five dialects for a fresh user, and setup forms a
// steady-state household scrolls past forever. The function was complete; the delivery
// shape was the problem.
//
// So the page became a FORMATTER over one decision: this module answers "what is the next
// step?" and the page renders only that step's card. One question, one computation — the
// same discipline `portalStatusLine` (#1756) applies to the status sentence.
//
// NO NEW STORAGE. A stage is derived from rows that already exist — the registry, the
// tokens, the run reports, the pending list. There is deliberately no "setup_step" column
// and no settings flag: a stored stage would be a second answer that could disagree with
// the data, and a household that adds a second portal a year later re-enters the flow
// naturally because the derivation is data-driven rather than a wizard someone finished.
//
// PER-VIEWER, NOT PER-INSTANCE. Every count below is what THIS login may see (the
// registry through `listVisiblePortalRegistry`, reports through
// `listVisiblePortalRunReports`, pending behind `canManagePending`). A stage card is a
// next step, so it must describe a step its reader could actually take — pointing someone
// at a card they cannot see is the failure #1756 fixed in the status sentence, and it
// would be the same failure here. Scoping happens in the reads, never in this module.

export type PortalSetupStage =
  // 1. Nothing registered that this viewer can see. The page is an introduction.
  | "no-portals"
  // 2. A portal exists, nothing has ever run, and no upload token exists for the
  //    companion tool to present.
  | "create-token"
  // 3. A portal and a token exist; the tool has never reported a run.
  | "first-run"
  // 4. The tool reported patients allos could not place. Mapping them is the page.
  | "map-patients"
  // 5. Set up and running. Status, then a compact per-patient summary.
  | "steady";

export interface PortalSetupFacts {
  // Portals this viewer can see. Zero is the fresh-instance case.
  portalCount: number;
  // Whether ANY live `upload:documents` API token exists on the instance. Instance-wide
  // on purpose: the token belongs to the COMPUTER that runs the tool, which is often a
  // different login's machine, so "do I personally hold one?" is the wrong question and
  // would strand a caregiver in stage 2 forever. It is a bare boolean — no name, no
  // owner, no count — so it says only "the tool has a way in", which is the fact the
  // next step turns on.
  hasUploadToken: boolean;
  // Run reports visible to this viewer. Reports are ACCOUNT-level and carry no
  // profile_id — that is what puts a run there — so visibility is decided by the
  // account's reachability (#1787/#1791) before it gets here.
  reportCount: number;
  // Patients the tool reported that allos could not place, as the viewer sees them.
  // Zero for a login that could not act on them at all.
  pendingCount: number;
}

// The waterfall. Order is the whole content of this function, so it is stated plainly:
//
//   no portals  →  patients waiting  →  no token yet  →  no run yet  →  steady
//
// TWO ORDERING DECISIONS ARE DELIBERATE, and both exist to keep a later state from
// falling back into an earlier one:
//
//   PENDING OUTRANKS EVERYTHING BUT THE EMPTY REGISTRY. A pending row is work only a
//   human can finish, and it is the one thing on this page that blocks records from
//   being filed at all. It also cannot exist without a run having reported it, so
//   ranking it above the token and first-run stages never skips a step a household
//   still owes — it only stops "your token was revoked" from hiding three patients
//   waiting to be mapped.
//
//   THE TOKEN AND FIRST-RUN STAGES ARE PRE-RUN ONLY. Once a run has been reported the
//   household is past setup, and a revoked or rotated token must not drag the page back
//   to "create a token for the computer that will run the tool" — that sentence is
//   first-contact guidance, and a household that has been syncing for a year would read
//   it as the page forgetting them. A token that stops working surfaces where it
//   actually shows up: the run fails, and the status line says so.
export function portalSetupStage(facts: PortalSetupFacts): PortalSetupStage {
  if (facts.portalCount <= 0) return "no-portals";
  if (facts.pendingCount > 0) return "map-patients";
  if (facts.reportCount <= 0) {
    return facts.hasUploadToken ? "first-run" : "create-token";
  }
  return "steady";
}
