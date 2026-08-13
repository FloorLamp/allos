"use server";

import { redirect } from "next/navigation";
import { revalidateRoute } from "@/lib/revalidate";
import {
  requireSession,
  requireProfileWriteAccess,
  getAccessibleProfiles,
  setActiveProfile,
} from "@/lib/auth";
import { today } from "@/lib/db";
import { markDoseTaken, undoDoseConfirm, dismissFinding } from "@/lib/queries";
import { householdSetupForProfile } from "@/lib/queries/household-setup";
import {
  HOUSEHOLD_SETUP_CHECK_IDS,
  type HouseholdSetupCheckId,
} from "@/lib/household-setup";
import type {
  DoseConfirmResult,
  DoseUndoResult,
} from "@/lib/dose-outcome-text";

// Switch the current session's active profile to the clicked household card and
// jump to that profile's dashboard — the same "set active profile + navigate" the
// header switcher does, in one click. Open to any logged-in caller (issue #31):
// setActiveProfile independently re-checks that the login may act as the target
// (admins may act as any; members only their granted profiles), so a read-only
// member can still switch, and an inaccessible target is a no-op.
export async function openProfileAction(formData: FormData) {
  await requireSession();
  const profileId = Number(formData.get("profileId"));
  if (profileId) await setActiveProfile(profileId);
  redirect("/");
}

// Confirm a due dose for a household member WITHOUT switching the active profile
// (issue #31). The target profile comes from the form, so this must gate on THAT
// profile, not the active one: requireProfileWriteAccess(profileId) asserts the
// caller can reach AND write the target (a read-only caregiver is bounced to the
// app root before any write). markDoseTaken is itself profile-scoped and idempotent
// — it verifies the dose belongs to the target profile via its parent supplement
// and logs it once — so a tampered dose_id from another profile is dropped even
// past the access gate.
//
// The result CARRIES markDoseTaken's typed outcome (#2106): this surface's own
// one-tap registry entry declares `outcome-toast`, and the action had been dropping
// the outcome and returning void — so a tap on a dose whose item was meanwhile
// paused, or whose dose row a schedule edit retired, logged nothing and said
// nothing, on a medication-adherence surface. The card's confirm button renders
// every branch through doseConfirmMessage.
export async function confirmDoseAction(
  formData: FormData
): Promise<DoseConfirmResult> {
  const profileId = Number(formData.get("profileId"));
  const doseId = Number(formData.get("dose_id"));
  if (!profileId || !doseId)
    return { ok: false, error: "Couldn't find that dose." };
  await requireProfileWriteAccess(profileId);
  const outcome = markDoseTaken(profileId, doseId, null, today(profileId));
  revalidateRoute("/household");
  revalidateRoute("/nutrition");
  revalidateRoute("/medications");
  revalidateRoute("/");
  return { ok: true, outcome };
}

// Take back the card's confirm (#2642) — the inverse behind its Undo toast. The gate is
// the CONFIRM'S gate, re-run: requireProfileWriteAccess on the profile the form names,
// never the active one, so a read-only caregiver cannot un-log a member's dose any more
// than they could log it. undoDoseConfirm is itself profile-scoped through the parent
// item, so a tampered dose_id from a third profile is dropped past the access gate too.
//
// A caregiver's undo is still only their OWN tap being taken back: the inverse refuses
// the moment the day's ledger is no longer the single taken row that confirm wrote, so a
// second caregiver's confirm, or a skip recorded in between, is never erased by it.
export async function undoConfirmDoseAction(
  formData: FormData
): Promise<DoseUndoResult> {
  const profileId = Number(formData.get("profileId"));
  const doseId = Number(formData.get("dose_id"));
  if (!profileId || !doseId)
    return { ok: false, error: "Couldn't find that dose." };
  await requireProfileWriteAccess(profileId);
  const outcome = undoDoseConfirm(profileId, doseId, today(profileId));
  revalidateRoute("/household");
  revalidateRoute("/nutrition");
  revalidateRoute("/medications");
  revalidateRoute("/");
  return { ok: true, outcome };
}

// ── Member setup health (issue #2173) ─────────────────────────────────────────

// Follow a setup check's MEMBER-scoped CTA: switch the session's active profile to the
// card's member, then land on that check's own fix surface (their onboarding, their dose
// editor, their Upcoming). The household card links nothing cross-profile directly —
// #879: a cross-profile deep link lands on a dead anchor — so the switch has to happen
// first, exactly as tapping the card header does.
//
// THE DESTINATION IS NEVER POSTED. The form carries the member's profile id and the
// check ID (validated against the closed union), and the route is RE-DERIVED server-side
// from the member's current facts. So there is no client-supplied redirect target, and a
// card left open while the underlying check was already fixed lands on the app root
// rather than on a stale deep link.
export async function openMemberSetupAction(formData: FormData) {
  await requireSession();
  const profileId = Number(formData.get("profileId"));
  const raw = String(formData.get("check") ?? "");
  const checkId = HOUSEHOLD_SETUP_CHECK_IDS.find(
    (id): id is HouseholdSetupCheckId => id === raw
  );
  if (!profileId || !checkId) redirect("/household");
  // READ-level gate, asserted BEFORE the member's facts are read: this is a navigation,
  // not a write, so a read-only caregiver may follow it — but a login that cannot reach
  // the profile must never derive anything from it. (`setActiveProfile` re-checks the
  // same thing independently for the switch itself.)
  const accessible = await getAccessibleProfiles();
  if (!accessible.some((p) => p.id === profileId)) redirect("/household");
  await setActiveProfile(profileId);
  const row = householdSetupForProfile(profileId, today(profileId));
  const cta = row?.checks.find((c) => c.id === checkId)?.cta ?? null;
  redirect(cta && cta.scope === "member" ? cta.href : "/");
}

// Dismiss a member's setup row for its CURRENT EPISODE — the failing-check SET, which is
// what the row's dedupeKey encodes. A newly failing check type changes the key and the
// row is offered again; the same set re-arising after a real fix is the documented
// data-quality-shaped behaviour of a type-keyed dismissal.
//
// The row is NEVER dismissible while the UNROUTABLE check is in the set (constraint 3:
// a standing "this profile is unroutable" dismissal must not exist). That is enforced
// HERE and not only in the renderer: the action re-derives the row and refuses to write
// a suppression for a non-dismissible one, so a hand-posted form cannot silence it
// either. `householdSetupForProfile` is the same reader the card rendered from, so the
// key can never be one the user was not actually offered.
//
// EVERY REFUSAL STILL REVALIDATES. The compare-and-swap can miss for three reasons, and
// all three mean the same thing: the card in front of the user no longer describes the
// member. The row is gone (their setup was fixed, or a prior dismissal already covers
// it), the set now carries `unroutable` and may not be silenced at all, or the failing
// set changed under an open tab so the posted key is stale. A bare `return` there is the
// neighbour of the rule two sections up in AGENTS.md — never confirm success
// unconditionally when the write can refuse — because a refusal nobody can SEE is the
// same lie told quietly: the tap does nothing and the page does not even re-render.
// Revalidating is the honest answer this surface can give in its own vocabulary: the
// card re-renders against the CURRENT failing set, so the row either changes shape or
// disappears, which reads as "that is not the row you were looking at". It writes
// nothing on that path.
export async function dismissMemberSetupAction(formData: FormData) {
  const profileId = Number(formData.get("profileId"));
  // NOT the same case: no member was named at all, so there is no card to re-render and
  // no claim to correct. Only a hand-posted form reaches this — every rendered control
  // carries its member — so the answer is to do nothing, quietly and completely.
  if (!profileId) return;
  // Silencing a finding about someone is a WRITE against their profile, so it takes
  // write access to THAT profile, not to the active one.
  await requireProfileWriteAccess(profileId);
  const row = householdSetupForProfile(profileId, today(profileId));
  if (
    row &&
    row.dismissible &&
    row.dedupeKey === String(formData.get("dedupe_key") ?? "")
  ) {
    dismissFinding(profileId, row.dedupeKey);
  }
  revalidateRoute("/household");
}
