// THE COMPOSED ONE-TAP, AS A THING A MESSAGE CAN CARRY (issue #2460).
//
// One button, the whole morning: the habitual food groups AND the doses declared for
// the window and still owed today, written in one tap by `logUsualRoutineCore`. The
// same offer the dashboard control renders (#2458), attached to a Telegram send that
// was already going out for its own reasons.
//
// ── IT DECORATES A MESSAGE; IT NEVER CAUSES ONE ──────────────────────────────
//
// `attachUsualRoutine` takes a message that ALREADY EXISTS and returns it with the
// bundle's line and button added. That is why no builder had to learn about it and why
// no send can be caused by it: a slot with nothing to say builds no message, and there
// is nothing to decorate. The contact-consent rule (docs/internals/findings.md §2)
// holds by construction rather than by review.
//
// ── THE LINE IS THE PROMISE; THE BUTTON IS THE COUNT ─────────────────────────
//
// The button label carries the bundle's name and count and the LINE above the keyboard
// names the full composed set, because a Telegram button truncates and a line does not.
// Both come from `usualRoutinePhrase` — the same function the dashboard control and its
// accessible name use — so no surface can promise this write in different words.
//
// ── AND THE RE-RENDER ONLY EVER REDUCES ──────────────────────────────────────
//
// `standingUsualAttachment` re-derives the bundle from fresh state and intersects it
// with the STORED offer, so a rebuild (a tap, the reconcile sweep) can only ever name
// LESS than the send did: a half already logged falls out of the line, and the whole
// button disappears once nothing stands. It can never name something the original
// offer did not, because the stored offer is the upper bound.

import { foodGroupName } from "../food-groups";
import type { FoodSlot } from "../food-slot";
import {
  proteinMemberName,
  usualRoutinePhrase,
  type UsualRoutineDose,
  type UsualRoutineOffer,
} from "../usual-routine";
import { getUsualRoutineOffer } from "../queries/usual-routine";
import {
  callbackDataFits,
  offerCallback,
  parseOfferCallback,
} from "./callback-data";
import { mintOffer, readOffer } from "./offer-store";
import { keyboardFamilyValid } from "./reconcile-registry";
import { tokenPrefix } from "./reconcile-core";
import { GLYPH } from "./glyphs";
import type { NotificationAction, NotificationMessage } from "./types";
import { joinBody } from "./rich-text";

// The offer family this module owns in `notify_offers`.
export const USUAL_OFFER_FAMILY = "usual-routine" as const;

// What the stored offer holds: the window and the two named sets, ids only. The
// display names are NOT stored — they are re-derived on every render from the same
// catalog and the same intake rows the dashboard reads, so a stored bundle can never
// name a group by a name the app has since changed.
export interface StoredUsualOffer {
  window: FoodSlot;
  groups: string[];
  doseIds: number[];
  // THE SCOOP THIS SEND PROMISED (#4379), or absent/null when protein was not a member.
  // Unlike the two lists above, the GRAMS are stored rather than re-derived, and that is
  // the point: "the stored offer's grams are what the tap writes even if the preset
  // changed after mint" — a message somebody read yesterday may not quietly become a
  // different promise because they used a bigger scoop this morning. Optional, so every
  // offer row minted before this shipped still parses and simply names no protein.
  proteinGrams?: number | null;
}

// One composed one-tap, already decided: which token, what it promises, what its
// button says. A builder or a rebuild path takes this and renders it — it decides
// nothing and asks nothing about what else may be sending.
export interface UsualRoutineAttachment {
  token: string;
  label: string;
  line: string;
}

// The row key the bundle's button sits on. Its own row: it is the upgrade of the
// keyboard beneath it, not a sibling of any one button on it.
export const USUAL_ROW = "usual-routine";

// The sentence the message says out loud, and the button that performs it — or null
// when the token does not fit Telegram's callback budget.
//
// THE DROP RULE LIVES HERE, at the one place a token becomes a rendered button, so
// every path that renders one obeys it: the send-plan's mint, and every rebuild that
// re-derives an attachment from a delivered keyboard. There is no shape of this that
// keeps part of the offer — an offer may never name less than the tap would write
// (#2460), the same rule #3098's per-stack one-tap ships at
// lib/notifications/intake-format.ts.
export function usualRoutineAttachmentFor(
  offer: UsualRoutineOffer,
  token: string
): UsualRoutineAttachment | null {
  if (!callbackDataFits(token)) return null;
  // The protein member is named in the same breath as the groups (#4379), so the line,
  // the count and the label pick it up without a second vocabulary.
  const foodNames = [
    ...offer.groups.map((slug) => foodGroupName(slug)),
    ...(offer.proteinGrams === null
      ? []
      : [proteinMemberName(offer.proteinGrams)]),
  ];
  const phrase = usualRoutinePhrase(foodNames, offer.doses);
  return {
    token,
    // The COUNT is every write the tap performs — servings plus dose confirms — so the
    // number on the button and the things named on the line are the same things.
    label: `${GLYPH.done} Your usual ${offer.window} (${foodNames.length + offer.doses.length})`,
    line: `${GLYPH.done} Your usual ${offer.window}: ${phrase}`,
  };
}

// Add the bundle to a message that is already being sent. The button goes FIRST — it
// is the one-tap upgrade of the rows beneath it, and a reader scanning a keyboard
// meets the whole-routine button before the per-row ones. `owningFamily` skips it
// regardless of position (`family: "host"`), so leading the keyboard costs the host
// message nothing.
export function attachUsualRoutine(
  message: NotificationMessage,
  attachment: UsualRoutineAttachment | null
): NotificationMessage {
  if (!attachment) return message;
  const button: NotificationAction = {
    label: attachment.label,
    data: attachment.token,
    row: USUAL_ROW,
  };
  // IDEMPOTENT, because two places legitimately apply the same attachment to the same
  // message. The reconcile sweep must attach BEFORE it plans, so the keyboard it
  // compares against the delivered one is the keyboard it is actually about to send
  // (otherwise every tick would "differ" and edit a message nothing had changed on);
  // the rebuild chokepoint then applies it again for every OTHER rebuild path. A
  // second application replaces the button and leaves the line alone — it is already
  // in the body, and a message may never promise the same write twice.
  const actions = message.actions ?? [];
  const already = actions.some(
    (a) => a.data != null && parseOfferCallback(a.data, "usual") != null
  );
  return {
    ...message,
    body: already
      ? message.body
      : joinBody([message.body, attachment.line], "\n"),
    actions: [
      button,
      ...actions.filter(
        (a) => a.data == null || parseOfferCallback(a.data, "usual") == null
      ),
    ],
  };
}

// The composed one-tap a DELIVERED keyboard is showing, re-derived against fresh state
// — or null when it never carried one, or when nothing it named still stands. The one
// question both the sweep and the rebuild chokepoint ask.
export function attachmentOnKeyboard(
  profileId: number,
  keyboard: readonly { callback_data?: string }[][],
  date: string
): UsualRoutineAttachment | null {
  const token = usualTokenOn(keyboard);
  return token ? standingUsualAttachment(profileId, token, date) : null;
}

// MINT the offer for a window, or null when there is nothing to offer.
//
// Three ways to answer null, and each is the whole button rather than a smaller one:
//
//   • no standing bundle — `getUsualRoutineOffer` gates on the food half, so no
//     habitual food offer means no control at all (and the fasting stand-down, #2757,
//     is inherited from it for free);
//   • the caller's consent gate said no (the bundle always contains food writes, and
//     food-buttons-in-chat is an expressed opt-in);
//   • the token would not fit Telegram's 64 bytes (the check inside
//     `usualRoutineAttachmentFor`). Under the stored-offer shape that is a
//     constant-size token and cannot happen for any plausible id — which is exactly
//     why it is CHECKED rather than assumed: the day an id or a prefix grows, the
//     button is DROPPED, never truncated, because an offer may never name less than
//     the tap would write.
export function mintUsualRoutineAttachment(
  profileId: number,
  window: FoodSlot,
  date: string
): UsualRoutineAttachment | null {
  const offer = getUsualRoutineOffer(profileId, window, date);
  if (!offer) return null;
  const payload: StoredUsualOffer = {
    window: offer.window,
    groups: offer.groups,
    doseIds: offer.doses.map((d) => d.doseId),
    proteinGrams: offer.proteinGrams,
  };
  const offerId = mintOffer(profileId, USUAL_OFFER_FAMILY, date, payload);
  return usualRoutineAttachmentFor(
    offer,
    offerCallback("usual", profileId, offerId)
  );
}

// The bundle a stored offer NAMES, or null when it names nothing that still stands.
//
// The intersection of the stored offer with what currently stands — the same rule the
// write core applies, read-only. Used by every rebuild path (a tap, the reconcile
// sweep) so a re-rendered keyboard can never offer more than currently stands, and by
// the handler to answer honestly before it writes.
export function standingUsualOffer(
  profileId: number,
  offerId: number,
  date: string
): UsualRoutineOffer | null {
  const stored = readOffer<StoredUsualOffer>(
    profileId,
    USUAL_OFFER_FAMILY,
    offerId,
    date
  );
  if (!stored) return null;
  const fresh = getUsualRoutineOffer(profileId, stored.window, date);
  if (!fresh) return null;
  const offeredGroups = new Set(stored.groups);
  const offeredDoses = new Set(stored.doseIds);
  const groups = fresh.groups.filter((g) => offeredGroups.has(g));
  const doses: UsualRoutineDose[] = fresh.doses.filter((d) =>
    offeredDoses.has(d.doseId)
  );
  // The protein member reduces exactly as a group does: it survives only while BOTH the
  // stored offer named it and the fresh one still stands it (#4379). The grams are the
  // STORED ones — the promise the reader saw — never the preset as it is now.
  const proteinGrams =
    stored.proteinGrams != null && fresh.proteinGrams !== null
      ? stored.proteinGrams
      : null;
  // THE FLOOR THE REDUCTION BOTTOMS OUT ON. A bundle earns its place by being FASTER
  // than the rows beneath it, which is the same rule `usualFoodOffer` states for the
  // food half alone (FOOD_USUAL_MIN_GROUPS: "a single group is one tap either way").
  // Generalised to the composition, because after a reduction the two halves are
  // interchangeable as savings: the remainder must be at least two writes, and it must
  // still contain food — the food half is this offer's GATE and there was never a
  // dose-only shape of it (lib/usual-routine.ts).
  const foodMembers = groups.length + (proteinGrams === null ? 0 : 1);
  if (foodMembers === 0 || foodMembers + doses.length < 2) return null;
  return { window: stored.window, groups, proteinGrams, doses };
}

// The attachment a LIVE token still stands for, for a rebuild. Null once nothing
// stands, which is how the button disappears from a rebuilt keyboard.
export function standingUsualAttachment(
  profileId: number,
  token: string,
  date: string
): UsualRoutineAttachment | null {
  const parsed = parseOfferCallback(token, "usual");
  if (!parsed || parsed.profileId !== profileId) return null;
  const offer = standingUsualOffer(profileId, parsed.offerId, date);
  return offer ? usualRoutineAttachmentFor(offer, token) : null;
}

// The `usual:` token on a delivered keyboard, or null. The rebuild paths harvest it
// from the message they are re-rendering, so a rebuild carries the SAME offer the send
// minted rather than minting a second one for the same slot.
export function usualTokenOn(
  rows: readonly { callback_data?: string }[][]
): string | null {
  return (
    rows.flat().find((b) => parseOfferCallback(b.callback_data, "usual"))
      ?.callback_data ?? null
  );
}

// THE PRE-DISPATCH ASSERTION (#2460). Two things must hold of any message carrying the
// composed one-tap, and both are cheap to check and expensive to get wrong:
//
//   • AT MOST ONE `usual:` token. Two would be two offers for one slot, and the second
//     tap would redeem a bundle the first had already spent;
//   • the keyboard must have a family to INHERIT. `usual:` elects none (`family:
//     "host"`), so a keyboard of only host-inherited tokens is owned by nothing, swept
//     by nothing, and would sit in the chat forever.
//
// Returns the problem, or null when the message is fit to send. The caller drops the
// ATTACHMENT rather than the message: a dose reminder is safety tier and must go out
// even if its decoration is wrong.
export function usualDispatchProblem(
  message: NotificationMessage
): string | null {
  const tokens = (message.actions ?? [])
    .map((a) => a.data)
    .filter((d): d is string => d != null);
  const usual = tokens.filter((t) => parseOfferCallback(t, "usual") != null);
  if (usual.length === 0) return null;
  if (usual.length > 1)
    return `${usual.length} composed one-tap tokens on one message`;
  if (!keyboardFamilyValid(tokens, tokenPrefix))
    return "a host-inherited token on a keyboard with no family to inherit";
  return null;
}
