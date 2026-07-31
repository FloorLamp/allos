"use server";
// Patient-portal acquirer setup actions (#1739) — the portal registry, the per-portal
// LOGIN (account) registry, and the `(portal, login, patient-label) → profile` bindings.
//
// AUTH TIERS. There are three, and they differ because the things being written differ:
//
//   requireAdmin()                  — the REGISTRIES. A portal and its logins are
//     instance-scoped vocabulary a household shares (like the `providers` registry):
//     one "Ochsner MyChart", one "Mom". They name no profile, so no per-profile grant
//     could stand in for the gate.
//
//   requireProfileWriteAccess(T)    — anything that ROUTES records at a profile. A
//     binding decides WHERE a person's records land, so it gates on the TARGET profile,
//     not the session's active one: binding grandma's portal patient to grandma's
//     profile from your own session is the normal case, which is exactly what
//     requireWriteAccess() (active profile only) would get wrong. That guard resolves the
//     session, refuses in demo mode, asserts the caller can REACH the target, and asserts
//     WRITE on it — in that order, because accessForProfile assumes reachability.
//
//   requireAnyProfileWriteAccess()  — the PENDING LIST's non-routing actions (ignore,
//     dismiss). See its definition for why it exists and what it deliberately does not
//     assert.
//
// The lib/portals.ts cores are auth-blind by house rule; every gate lives here.

import { revalidatePath } from "next/cache";
import {
  accessForProfile,
  getAccessibleProfiles,
  requireAdmin,
  requireProfileWriteAccess,
  requireSession,
} from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import {
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  deletePortal,
  deletePortalAccount,
  dismissPendingIdentity,
  ignorePortalIdentity,
  pendingIdentity,
  portalIdentityState,
  renamePortal,
  unbindPortalIdentity,
  unignorePortalIdentity,
} from "@/lib/portals";
import { requestSync } from "@/lib/portal-requests";

export type PortalActionResult = { ok: true } | { ok: false; error: string };

const CARD = "/integrations/patient-portals";

// The gate for pending-list actions that route NOTHING: ignoring a patient label and
// dismissing a prompt. Neither names a profile, so requireProfileWriteAccess has no
// target, and requireWriteAccess would assert the wrong thing (the session's ACTIVE
// profile, which is unrelated to a portal login).
//
// What it asserts instead is the honest minimum: this login could act on the pending list
// at all — it holds WRITE on at least one profile, i.e. it is in the same population the
// bind picker already serves. A caregiver who can write nowhere cannot silence a portal
// identity, and neither can a read-only viewer.
//
// This is the gate the OWNER chose when they made the pending list member-visible. The
// earlier admin-only reasoning — a pending row has no profile, so there is no accessible
// set to filter a stranger's portal-spelled name through — remains factually true; the
// exposure of portal-spelled patient labels to non-admin members WITH WRITE ACCESS is an
// accepted trade, not an oversight. Do not "restore" the admin gate on that reasoning.
async function requireAnyProfileWriteAccess(): Promise<void> {
  const session = await requireSession();
  if (isDemoRestricted(isDemoMode(), session.login.role)) {
    throw new Error("blocked in demo mode");
  }
  if (session.login.role === "admin") return;
  const reachable = await getAccessibleProfiles();
  const canWriteSomething = reachable.some(
    (p) =>
      accessForProfile(session.login.id, session.login.role, p.id) === "write"
  );
  if (!canWriteSomething) {
    throw new Error("no write access to any profile");
  }
}

// ── Portal registry ──────────────────────────────────────────────────────────

export async function addPortalAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAdmin();
  const name = String(formData.get("name") ?? "");
  const software = String(formData.get("software") ?? "");
  // createPortal owns the validation, including the refusal of URL-shaped input — the
  // schema has no address column, and this is the one free-text field where one could
  // otherwise enter the record. It also MINTS the slug and creates the portal's implicit
  // login, so a single-login household never meets the account concept.
  const r = createPortal(name, software);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(CARD);
  return { ok: true };
}

export async function renamePortalAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAdmin();
  const id = Number(formData.get("portal_id"));
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "Unknown portal." };
  }
  // Renames the DISPLAY NAME only — the slug every tool config quotes is untouched, which
  // is the entire reason allos mints it rather than letting a human type it.
  const r = renamePortal(id, String(formData.get("name") ?? ""));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(CARD);
  return { ok: true };
}

export async function removePortalAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAdmin();
  const id = Number(formData.get("portal_id"));
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "Unknown portal." };
  }
  if (!deletePortal(id))
    return { ok: false, error: "That portal is already gone." };
  revalidatePath(CARD);
  return { ok: true };
}

// ── Login (account) registry ─────────────────────────────────────────────────

export async function addAccountAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAdmin();
  const portalId = Number(formData.get("portal_id"));
  if (!Number.isInteger(portalId) || portalId <= 0) {
    return { ok: false, error: "Choose a portal." };
  }
  // A NICKNAME for which login this is ("Mom"), never a username and never a credential.
  // createPortalAccount mints the slug and refuses address-shaped text.
  const r = createPortalAccount(portalId, String(formData.get("name") ?? ""));
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(CARD);
  return { ok: true };
}

export async function removeAccountAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAdmin();
  const id = Number(formData.get("account_id"));
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "Unknown login." };
  }
  // Refuses to remove a portal's LAST login: every binding must name one, so a portal
  // with none could never be bound again — a dead end reached by a single click.
  if (!deletePortalAccount(id)) {
    return {
      ok: false,
      error:
        "That login is already gone, or it is the portal's only one — remove the portal instead.",
    };
  }
  revalidatePath(CARD);
  return { ok: true };
}

// ── Bindings ─────────────────────────────────────────────────────────────────

export async function bindIdentityAction(
  formData: FormData
): Promise<PortalActionResult> {
  const accountId = Number(formData.get("account_id"));
  const profileId = Number(formData.get("profile_id"));
  const label = String(formData.get("patient_label") ?? "");
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return { ok: false, error: "Choose a portal login." };
  }
  if (!Number.isInteger(profileId) || profileId <= 0) {
    return { ok: false, error: "Choose a profile." };
  }
  // The gate is on the TARGET profile: you may only route a portal patient onto a
  // profile you could write to yourself. Throws (redirect) if not — so a forged post
  // aborts before the binding is written.
  await requireProfileWriteAccess(profileId);

  const r = bindPortalIdentity(accountId, label, profileId);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(CARD);
  return { ok: true };
}

export async function unbindIdentityAction(
  formData: FormData
): Promise<PortalActionResult> {
  const id = Number(formData.get("identity_id"));
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, error: "Unknown mapping." };
  }
  // THE PROFILE IS RESOLVED SERVER-SIDE, NEVER TAKEN FROM THE POST (#1747).
  //
  // The row id arrives from a client, and the only profile that means anything here is
  // the one the row ACTUALLY points at. An earlier version gated on a `profile_id` field
  // from the same FormData, which authorized nothing: a caller with legitimate write
  // access to their own profile A could post `identity_id=<a row owned by profile B>` +
  // `profile_id=A`, pass the gate on A, and delete B's binding.
  const state = portalIdentityState(id);
  if (!state) {
    return { ok: false, error: "That mapping is already gone." };
  }
  if (state.ignored) {
    // An IGNORED binding points at no profile — there is nothing to authorize against, so
    // it takes the pending-list tier instead, and the delete is scoped to `ignored = 1`
    // so this path can never remove a live binding.
    await requireAnyProfileWriteAccess();
    if (!unignorePortalIdentity(id)) {
      return { ok: false, error: "That mapping is already gone." };
    }
    revalidatePath(CARD);
    return { ok: true };
  }
  const owner = state.profileId;
  if (owner === null) {
    return { ok: false, error: "That mapping is already gone." };
  }
  // Removing a binding is the same class of decision as creating one — it changes where
  // this patient's future records go (namely: nowhere, refused) — so it takes the same
  // gate on the profile the binding currently points at.
  await requireProfileWriteAccess(owner);

  // Compare-and-swap on the profile that was just authorized: if a concurrent bind
  // re-pointed the row at a different profile in between, this deletes nothing and the
  // caller is told so, rather than removing a binding under an authorization that no
  // longer describes it. Access-control-adjacent writes are atomic, not last-write-wins.
  if (!unbindPortalIdentity(id, owner)) {
    return { ok: false, error: "That mapping is already gone." };
  }
  revalidatePath(CARD);
  return { ok: true };
}

// ── Pending (refused and discovered) identities ──────────────────────────────
//
// A pending row is an identity allos could not place — either refused at upload/report
// time, or DISCOVERED and reported by a run before anything was pushed for it. It has no
// profile — that is the definition — so the three actions below gate differently on
// purpose:
//
//   binding one  → requireProfileWriteAccess(TARGET). It IS that write; the pending row
//                  only supplies the (login, label) the caller would otherwise retype.
//   ignoring one → requireAnyProfileWriteAccess(). It routes nothing, and writes a
//                  binding that deliberately points nowhere.
//   dismissing   → requireAnyProfileWriteAccess(). It clears a prompt and nothing else.

// One-tap mapping straight off the card (#1739). The (login, label) come from the PENDING
// ROW, resolved server-side — the client names which pending row and which profile, never
// the label — so the identity that gets bound is character-for-character the one that was
// reported. Retyping it by hand is exactly how a household binds a subtly different key
// and gets refused again for a reason nobody can see.
export async function bindPendingIdentityAction(
  formData: FormData
): Promise<PortalActionResult> {
  const pendingId = Number(formData.get("pending_id"));
  const profileId = Number(formData.get("profile_id"));
  if (!Number.isInteger(pendingId) || pendingId <= 0) {
    return { ok: false, error: "Unknown pending patient." };
  }
  if (!Number.isInteger(profileId) || profileId <= 0) {
    return { ok: false, error: "Choose a profile." };
  }
  const pending = pendingIdentity(pendingId);
  if (!pending) {
    return { ok: false, error: "That pending patient is already handled." };
  }
  await requireProfileWriteAccess(profileId);

  // bindPortalIdentity CLEARS the pending row in the same transaction, so the list and
  // the binding can never disagree — there is no window where the card still offers to
  // map an identity that is already mapped.
  const r = bindPortalIdentity(
    pending.accountId,
    pending.patientLabel,
    profileId
  );
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(CARD);
  return { ok: true };
}

// "Not ever" — a real person on the portal whose records belong somewhere else. Writes a
// durable IGNORED binding (no profile, by CHECK), so the identity stops being pending and
// stays that way, and every future upload for it is refused exactly like an unknown one.
export async function ignorePendingIdentityAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAnyProfileWriteAccess();
  const pendingId = Number(formData.get("pending_id"));
  if (!Number.isInteger(pendingId) || pendingId <= 0) {
    return { ok: false, error: "Unknown pending patient." };
  }
  const pending = pendingIdentity(pendingId);
  if (!pending) {
    return { ok: false, error: "That pending patient is already handled." };
  }
  const r = ignorePortalIdentity(pending.accountId, pending.patientLabel);
  if (!r.ok) return { ok: false, error: r.error };
  revalidatePath(CARD);
  return { ok: true };
}

// "Not now" — clears the prompt only. Deliberately NOT durable: if the tool reports the
// identity again it comes back, because the dismissal answered the row, not the portal.
// That is the difference from IGNORE, and the reason both exist.
export async function dismissPendingIdentityAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAnyProfileWriteAccess();
  const pendingId = Number(formData.get("pending_id"));
  if (!Number.isInteger(pendingId) || pendingId <= 0) {
    return { ok: false, error: "Unknown pending patient." };
  }
  if (!dismissPendingIdentity(pendingId)) {
    return { ok: false, error: "That pending patient is already handled." };
  }
  revalidatePath(CARD);
  return { ok: true };
}

// ── Sync requests (#1757) ────────────────────────────────────────────────────

// "Request sync" on the card — the MANUAL creator, for when the person who manages allos
// is not the person whose laptop holds the portal login.
//
// GATE: requireAnyProfileWriteAccess, the same one the pending list takes. A request
// names a portal LOGIN and no profile, so there is no target for
// requireProfileWriteAccess and the session's ACTIVE profile is unrelated to it. The
// honest minimum is the population the card already serves — a login that holds write
// somewhere, i.e. someone who could act on the records a run would bring in.
//
// The core is auth-blind (lib/portal-requests.ts) and returns a TYPED outcome this
// renders rather than confirming unconditionally: an already-open request of equal or
// greater salience is a no-op, and a portal login with no mapped patients is refused —
// a nudge there would have no Upcoming to live on and nobody to reach.
export async function requestSyncAction(
  formData: FormData
): Promise<PortalActionResult> {
  await requireAnyProfileWriteAccess();
  const accountId = Number(formData.get("account_id"));
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return { ok: false, error: "Unknown portal login." };
  }
  const out = requestSync(accountId, "manual");
  if (!out.ok) {
    return {
      ok: false,
      error:
        out.error === "no-mapped-patients"
          ? "Map at least one patient on this login first — otherwise the reminder has nobody to reach."
          : "Unknown portal login.",
    };
  }
  if (!out.created) {
    return {
      ok: false,
      error: "A sync is already requested for this login.",
    };
  }
  revalidatePath(CARD);
  revalidatePath("/upcoming");
  return { ok: true };
}
