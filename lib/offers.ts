// THE OFFER-FAMILY REGISTRY (issue #4840, ruling 1) — every setting that is offered
// at the moment you act, declared once.
//
// Seven settings were already offered at their moment — the wear reminder (#2162), the
// digest time (#2217), the food buttons (#682), the travel timezone (#3263) — and each
// kept its own "did we ask" in a different place: a KV flag, a dismissal key, a
// lifecycle key, a streak counter. Nothing declared the shape, so every new offer was
// hand-built, and six settings whose moment plainly existed were never wired at all.
//
// This is the declaration. It is the sibling of the three per-kind registries in
// lib/notifications (`kinds.ts`, `reconcile-registry.ts`, `cadence-registry.ts`) and
// speaks their vocabulary — every family names the NotificationKind whose setting it
// writes — rather than a fourth one. A family is TOTAL by type: `Record<OfferFamilyId,
// OfferFamily>` refuses a family missing any part, so there is no guard and no test
// policing completeness.
//
// ── The three rules every family lives under ─────────────────────────────────
//
//   1. `writes` runs from the Yes tap and from nowhere else. Ignoring an offer enables
//      nothing; declining it enables nothing. The system may reduce contact on its own
//      and may never increase it (docs/internals/findings.md §2) — #2162's constraint,
//      restated for every family at once.
//   2. "Did we ask" lives on the suppression bus (`upcoming_dismissals`), under the
//      family's declared key class: `catalog` for a consent asked once, forever;
//      `anchored` for a question that recurs per episode. It is consulted BEFORE the
//      trigger runs, and ignoring is an answer: a rendered offer marks itself asked, so
//      the next visit does not repeat it. No bespoke `*_prompted` settings key may be
//      minted — the SettingKey type in lib/settings/kv.ts refuses one.
//   3. Two surfaces and never a third (ruling 2): IN PLACE, on the row or card the
//      person just used (components/OfferInPlace.tsx over the shared OfferControls),
//      and RIDING an existing send as a keyboard row (`offerRideAlongRows`). Never a
//      new send, never a dashboard card.
//
// The copy states the data, never the person ("Morning digest at 07:00?"), and a
// family's setting stays editable on Settings → Notifications: the offer is a faster
// door, not the only one.

import { today } from "./db";
import { offerAskedKey } from "./dismissal-keys";
import type { DismissalKeyClass } from "./dismissal-classes";
import { isHiddenUnderPolicy } from "./lifecycle";
import {
  DEFAULT_RECAP_MINUTE,
  getNotifySchedule,
  setDigestMinute,
  setDigestMode,
  setRecapSlot,
} from "./settings/notifications";
import { DIGEST_DEFAULT_MINUTE } from "./notifications/digest-schedule";
import { telegramChannel } from "./notifications/telegram";
import type { NotificationAction, NotificationKind } from "./notifications/types";
import {
  dismissFinding,
  getFindingSuppressions,
} from "./queries/upcoming/suppressions";
import { cache } from "./request-cache";

export type OfferFamilyId = "digest-on-connect" | "recap-on-connect";

/** The two render shapes (ruling 2). There is no third. */
export type OfferSurface = "in-place" | "ride-along";

export interface OfferFamily {
  /** The kind whose setting this family writes — the sibling registries' vocabulary. */
  kind: NotificationKind;
  /**
   * Pure eligibility over stored rows, for the profile-local day: the moment has
   * arrived and the setting is still unset. Never consults `asked` — that is the
   * caller's job, first — and never writes.
   */
  trigger(profileId: number, today: string): boolean;
  /** The setting flip. Called from the Yes tap and from nowhere else. */
  writes(profileId: number): void;
  surfaces: readonly OfferSurface[];
  /** The one-shot key on the suppression bus, and the class it is registered under. */
  asked: {
    keyClass: Extract<DismissalKeyClass, "catalog" | "anchored">;
    key: string;
  };
  /** One question, two verbs. */
  copy: { question: string; yes: string; no: string };
}

// The profile is reachable over Telegram: the bot is configured and a managing login
// has a live chat. The same predicate the send path gates on, so "connected" here can
// never mean something a message would not agree with.
function telegramReachable(profileId: number): boolean {
  return telegramChannel.isConfigured(profileId);
}

export const OFFER_FAMILIES: Record<OfferFamilyId, OfferFamily> = {
  // Telegram became reachable and there is no morning digest. Off by default with no
  // moment of its own until now; the connect prompt (#682) is the nearest send.
  "digest-on-connect": {
    kind: "digest",
    trigger: (profileId) =>
      telegramReachable(profileId) &&
      getNotifySchedule(profileId).digestMinute == null,
    writes(profileId) {
      setDigestMinute(profileId, DIGEST_DEFAULT_MINUTE);
      setDigestMode(profileId, "static");
    },
    surfaces: ["in-place", "ride-along"],
    asked: { keyClass: "catalog", key: offerAskedKey("digest-on-connect") },
    copy: {
      question: "Morning digest at 07:00?",
      yes: "Yes, send it",
      no: "No thanks",
    },
  },
  // The same moment, no recap day. Sunday 09:00 at the weekly scale — the schedule
  // form's own defaults, so the setting the tap writes is the one the form would have.
  "recap-on-connect": {
    kind: "weekly-recap",
    trigger: (profileId) =>
      telegramReachable(profileId) &&
      getNotifySchedule(profileId).weeklyRecapDay == null,
    writes(profileId) {
      setRecapSlot(profileId, 0, DEFAULT_RECAP_MINUTE, "week");
    },
    surfaces: ["in-place", "ride-along"],
    asked: { keyClass: "catalog", key: offerAskedKey("recap-on-connect") },
    copy: {
      question: "Weekly recap on Sundays at 09:00?",
      yes: "Yes, send it",
      no: "No thanks",
    },
  },
};

export const OFFER_FAMILY_IDS = Object.keys(OFFER_FAMILIES) as OfferFamilyId[];

/** The family whose `asked` key this is, or null — the action's only token. */
export function offerFamilyForKey(key: string): OfferFamilyId | null {
  return OFFER_FAMILY_IDS.find((id) => OFFER_FAMILIES[id].asked.key === key) ?? null;
}

function askedAlready(profileId: number, id: OfferFamilyId): boolean {
  const record = getFindingSuppressions(profileId).get(OFFER_FAMILIES[id].asked.key);
  return isHiddenUnderPolicy("normal", record, today(profileId));
}

/**
 * Is this family offering right now? The asked key first, then the trigger — the
 * order is rule 2: a family that has been answered, or shown once and ignored, is
 * never re-asked however eligible the rows still look.
 */
export function offerStands(profileId: number, id: OfferFamilyId): boolean {
  if (askedAlready(profileId, id)) return false;
  return OFFER_FAMILIES[id].trigger(profileId, today(profileId));
}

/** Every family offering right now, in declaration order. Gathered once per request. */
export const standingOffers = cache(function standingOffers(
  profileId: number
): OfferFamilyId[] {
  return OFFER_FAMILY_IDS.filter((id) => offerStands(profileId, id));
});

/**
 * Record that the offer was put in front of the person. Called on a render of the
 * in-place surface (ignored = asked) and by every answer; a `catalog` key is forever.
 */
export function markOfferAsked(profileId: number, id: OfferFamilyId): void {
  dismissFinding(profileId, OFFER_FAMILIES[id].asked.key);
}

export type OfferAnswer = "written" | "declined" | "stale";

/**
 * The Yes or No tap. Re-checks the TRIGGER (not the asked key — a rendered offer has
 * already marked itself asked) so a card left open cannot write over a setting the
 * person has since set by hand; a Yes then runs `writes`, and either answer marks the
 * family asked. This is the one path through which `writes` is ever reached.
 */
export function answerOffer(
  profileId: number,
  id: OfferFamilyId,
  yes: boolean
): OfferAnswer {
  const family = OFFER_FAMILIES[id];
  if (!family.trigger(profileId, today(profileId))) return "stale";
  if (yes) family.writes(profileId);
  markOfferAsked(profileId, id);
  return yes ? "written" : "declined";
}

/**
 * The RIDE-ALONG shape (ruling 2): one keyboard row per standing family, on a message
 * that is going out anyway. `token` mints the callback data — the token family and
 * its handler belong to the message's own module, which is what keeps this builder
 * free of the callback vocabulary and its reconcile declaration.
 */
export function offerRideAlongRows(
  ids: readonly OfferFamilyId[],
  token: (id: OfferFamilyId, yes: boolean) => string
): NotificationAction[] {
  return ids.flatMap((id) => {
    const { copy } = OFFER_FAMILIES[id];
    return [
      { label: `${copy.question} ${copy.yes}`, data: token(id, true), row: id },
      { label: copy.no, data: token(id, false), row: id },
    ];
  });
}
