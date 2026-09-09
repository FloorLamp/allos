"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import {
  answerOffer,
  markOfferAsked,
  offerFamilyForKey,
  type OfferInstance,
} from "@/lib/offers";
import { requirePoolWriteAccess } from "./supplies/access";
import { formError, formOk, type FormResult } from "@/lib/types";

// The three taps an in-place offer can take (issue #4840): Yes, No, and "seen".
//
// Every tap carries the asked key and resolves its family or item instance against
// the registry — a tampered form cannot name a setting that is not
// declared as an offer. `answerOffer` re-checks the family's trigger before writing,
// so a card left open on a phone cannot enable a digest someone has since configured
// by hand; the Yes tap is the ONLY path through which a family's `writes` runs
// (contact-consent rule, docs/internals/findings.md §2).
//
// Profile-scoped writes — the setting and the asked key are both the profile's — so
// the gate is requireWriteAccess: a read-only caregiver is shown no offer, and could
// not answer one if they were.

const STALE =
  "That offer is out of date — reload the page to see the current state.";

function familyFrom(formData: FormData): OfferInstance | null {
  return offerFamilyForKey(String(formData.get("dedupe_key") ?? "").trim());
}

async function answer(
  profileId: number,
  formData: FormData,
  yes: boolean
): Promise<FormResult> {
  const id = familyFrom(formData);
  let payload;
  if (id && typeof id !== "string" && yes) {
    const raw = String(formData.get("quantity_on_hand") ?? "").trim();
    const quantity = Number(raw);
    if (!raw || !Number.isFinite(quantity) || quantity < 0)
      return formError("Enter how many are left.");
    const supplyId = Number(formData.get("supply_id")) || null;
    if (supplyId != null) await requirePoolWriteAccess(supplyId);
    payload = { supplyId, quantity };
  }
  if (!id || answerOffer(profileId, id, yes, payload) === "stale")
    return formError(STALE);
  // The setting's own row on Settings → Notifications, and Upcoming's dismissal list.
  revalidateRoute("/settings/notifications");
  revalidateRoute("/upcoming");
  revalidateRoute("/nutrition");
  revalidateRoute("/medications");
  if (typeof id !== "string") revalidateRoute(`/medications/${id.itemId}`);
  revalidateRoute("/supplies");
  return formOk();
}

/** The Yes tap: the family's `writes`, then the asked key. */
export async function acceptOffer(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  return answer(profile.id, formData, true);
}

/** The No tap: the asked key and nothing else. */
export async function declineOffer(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  return answer(profile.id, formData, false);
}

/**
 * The offer was rendered where the person could see it (ignored = asked). Writes only
 * the asked key and revalidates nothing: the offer stays on screen until they leave.
 */
export async function markOfferSeen(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = familyFrom(formData);
  if (!id) return formError(STALE);
  if (!markOfferAsked(profile.id, id)) return formError(STALE);
  return formOk();
}
