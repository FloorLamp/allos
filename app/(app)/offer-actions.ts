"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import {
  answerOffer,
  markOfferAsked,
  offerFamilyForKey,
  type OfferFamilyId,
} from "@/lib/offers";
import { formError, formOk, type FormResult } from "@/lib/types";

// The three taps an in-place offer can take (issue #4840): Yes, No, and "seen".
//
// Every one carries the family's asked key and nothing else, and resolves the family
// from it against the registry — a tampered form cannot name a setting that is not
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

function familyFrom(formData: FormData): OfferFamilyId | null {
  return offerFamilyForKey(String(formData.get("dedupe_key") ?? "").trim());
}

async function answer(formData: FormData, yes: boolean): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = familyFrom(formData);
  if (!id || answerOffer(profile.id, id, yes) === "stale")
    return formError(STALE);
  // The setting's own row on Settings → Notifications, and Upcoming's dismissal list.
  revalidateRoute("/settings/notifications");
  revalidateRoute("/upcoming");
  return formOk();
}

/** The Yes tap: the family's `writes`, then the asked key. */
export async function acceptOffer(formData: FormData): Promise<FormResult> {
  return answer(formData, true);
}

/** The No tap: the asked key and nothing else. */
export async function declineOffer(formData: FormData): Promise<FormResult> {
  return answer(formData, false);
}

/**
 * The offer was rendered where the person could see it (ignored = asked). Writes only
 * the asked key and revalidates nothing: the offer stays on screen until they leave.
 */
export async function markOfferSeen(formData: FormData): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const id = familyFrom(formData);
  if (!id) return formError(STALE);
  markOfferAsked(profile.id, id);
  return formOk();
}
