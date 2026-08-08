"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { dismissFinding } from "@/lib/queries";
import { getStreamLifecycleOffers } from "@/lib/queries/stream-lifecycle";
import { setProfileWearReminder } from "@/lib/settings";
import {
  streamOfferTarget,
  type StreamOfferKind,
} from "@/lib/integrations/stream-lifecycle";
import { formError, formOk, type FormResult } from "@/lib/types";

// The four taps the continuous-stream lifecycle offers (issue #2162).
//
// ── The consent shape, which is the load-bearing part ────────────────────────
//
// `acceptStreamReminder` is the ONLY path in this feature that turns the #2161 setting
// ON, and `declineStreamReminder` is the only one that turns it off. Both are a user's
// tap. Nothing else — not the detector, not the gather, not the tick — writes that
// field, which is #2161's constraint 1 and the contact-consent rule
// (docs/internals/findings.md §2) in mechanism form:
//
//   • IGNORING THE ONBOARDING OFFER ENABLES NOTHING. There is no default-on, no
//     "helpful first send", no timed auto-accept. `dismissStreamOffer` (the No thanks
//     tap) writes a suppression row and touches the setting not at all, because there
//     was nothing on to turn off — "opt out" here means "stop offering", which is why
//     it is a dismissal rather than a disable.
//   • IGNORING THE OFFBOARDING PROMPT ALSO CHANGES NOTHING. The reminders paused
//     themselves days earlier at the expected-active gate — a reduction the system is
//     entitled to make unilaterally (§7) — and the prompt is the announcement, not the
//     mechanism. `keepStreamReminder` therefore writes only the dismissal: the setting
//     stays exactly as the user left it, behind a gate that reopens by itself.
//
// ── Every action carries the dedupeKey and nothing else ──────────────────────
//
// The (provider, stream) is derived from that single token and then re-checked against
// the LIVE offer list before any write (the #1670/#1505 precedent). Two consequences:
// a card left open on a phone while the watch came back cannot enable a reminder
// nobody is currently being offered, and a tampered form cannot reach an arbitrary
// provider — the key must name a stream that is offering exactly this kind right now.

const STALE =
  "That offer is out of date — reload the page to see the current state.";

/** The live offer this key names, when it is still being offered as `kind`. */
function liveOffer(
  profileId: number,
  dedupeKey: string,
  kind: StreamOfferKind
) {
  const target = streamOfferTarget(dedupeKey);
  if (!target || target.kind !== kind) return null;
  return (
    getStreamLifecycleOffers(profileId).find(
      (o) =>
        o.key === dedupeKey &&
        o.kind === kind &&
        o.provider === target.provider &&
        o.streamId === target.streamId
    ) ?? null
  );
}

// Every surface an offer or the setting it writes can appear on. The dashboard card
// and the integrations surface both render the offer list, Settings → Notifications
// renders the toggle and its paused note, and Upcoming lists the dismissal.
function revalidateStreamLifecycleSurfaces(): void {
  revalidateRoute("/");
  revalidateRoute("/data");
  revalidateRoute("/settings/notifications");
  revalidateRoute("/upcoming");
}

/**
 * "Yes, remind me" — the onboarding accept. Turns the #2161 setting on AND dismisses
 * the offer, because a consented feature has nothing left to offer: the setting is now
 * the only place it lives, and Settings → Notifications is where it is turned back off.
 */
export async function acceptStreamReminder(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!liveOffer(profile.id, dedupeKey, "onboard")) return formError(STALE);
  setProfileWearReminder(profile.id, true);
  dismissFinding(profile.id, dedupeKey);
  revalidateStreamLifecycleSurfaces();
  return formOk();
}

/**
 * "No thanks" — the onboarding decline. A dismissal and NOTHING ELSE: there is no
 * setting to turn off, because the offer never turned one on. Permanent per
 * (provider, stream); a different provider, or a new stream, mints a different key and
 * is therefore a new offer.
 */
export async function dismissStreamReminderOffer(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!liveOffer(profile.id, dedupeKey, "onboard")) return formError(STALE);
  dismissFinding(profile.id, dedupeKey);
  revalidateStreamLifecycleSurfaces();
  return formOk();
}

/**
 * "Turn them off" — the offboarding accept. The user's tap is the write; the lapse
 * itself never was one. The dismissal rides along so the prompt does not repeat inside
 * this episode.
 */
export async function declineStreamReminder(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!liveOffer(profile.id, dedupeKey, "offboard")) return formError(STALE);
  setProfileWearReminder(profile.id, false);
  dismissFinding(profile.id, dedupeKey);
  revalidateStreamLifecycleSurfaces();
  return formOk();
}

/**
 * "Keep them ready" — the §7 confirm-to-KEEP half. Writes only the episode dismissal;
 * the setting stays enabled behind the gate, which means zero sends while the stream is
 * lapsed and an automatic resume the moment data arrives. No ceremony either way.
 */
export async function keepStreamReminder(
  formData: FormData
): Promise<FormResult> {
  const { profile } = await requireWriteAccess();
  const dedupeKey = String(formData.get("dedupe_key") ?? "").trim();
  if (!liveOffer(profile.id, dedupeKey, "offboard")) return formError(STALE);
  dismissFinding(profile.id, dedupeKey);
  revalidateStreamLifecycleSurfaces();
  return formOk();
}
