// The "Log other…" OFFER TAIL (issue #1505 Part 1, class 3: user-initiated access).
// Pure — no DB, no network — so the slot-scoping rule is unit-testable on its own.
//
// THE PROBLEM IT SOLVES. `may` items are never pushed, by design. For a user who
// lives in the app that is fine — the Supplements page and quick log are always
// there. For a TAP-ONLY user (the owner's own posture: inline keyboards on pushed
// messages, no typing) "never pushed" would mean "unreachable", and an unreachable
// item is a deleted item with extra steps. So the daily digest — the one message that
// arrives regardless — carries a guaranteed access path as its FIRST inline button.
//
// THE SHAPE. Collapsed by default: one button, labelled with the CURRENT slot
// ("Log other (2 for bedtime)"). Tapping expands it IN PLACE into one-tap log buttons for
// the may items on offer right now, plus a collapse button. No new message is sent at
// any point — the whole interaction is keyboard edits on a message that already
// exists for its own reasons. That is the contact-consent rule in mechanism form: an
// edit is not a send.
//
// THE SLOT RULE, and why it is evaluated at TAP time. A digest is born in the morning
// and its keyboard may be tapped at bedtime. Scoping the offer by the slot the
// MESSAGE was built in would put breakfast items in front of someone at 11pm. So the
// expansion reads the profile-local clock AT TAP (slotHintCoversNow), and the tick
// re-labels the collapsed button at each slot boundary so what it promises stays true
// even untapped. Hint-less items are offered in every slot — no hint means no opinion.

import { TIME_BUCKET_LABELS, currentTimeBucket } from "../intake-schedule";
import type { NotificationAction } from "./types";
import { GLYPH } from "./glyphs";

// One may item as the tail renders it: enough to label a button and log a dose.
export interface OfferedItem {
  itemId: number;
  name: string;
  // The dose amount to show beside the name, already formatted by the caller.
  detail: string | null;
  // How many administrations are already logged today, so a re-tap is informed
  // rather than blind (a may item is legitimately logged several times a day).
  countToday: number;
}

// The callback token namespaces. Kept here beside the builders so the parser and the
// renderer can never disagree about the wire format.
export const OFFER_EXPAND_PREFIX = "offer";
export const OFFER_COLLAPSE_PREFIX = "offerc";

export function offerExpandToken(profileId: number, date: string): string {
  return `${OFFER_EXPAND_PREFIX}:${profileId}:${date}`;
}

export function offerCollapseToken(profileId: number, date: string): string {
  return `${OFFER_COLLAPSE_PREFIX}:${profileId}:${date}`;
}

// The COLLAPSED tail: one button, naming the slot it will open into. The slot label
// is the promise — "Log other (3 for bedtime)" says what tapping will show — which is
// exactly why the tick has to re-label it when the slot turns over.
//
// THE LABEL SAYS WHAT TAPPING DOES (#1819 item 8). It used to cram three things into
// one cryptic bar with two different separators — "➕ Log other… · midday (3)" — where
// the ellipsis, the slot and the count all had to be decoded before the button could
// be trusted. Same guaranteed-access semantics, same slot rule, same re-label at each
// boundary; only the sentence changed.
export function collapsedOfferAction(
  profileId: number,
  date: string,
  nowHhmm: string,
  count: number
): NotificationAction {
  const slot = TIME_BUCKET_LABELS[currentTimeBucket(nowHhmm)].toLowerCase();
  return {
    label: `${GLYPH.more} Log other (${count > 0 ? `${count} for ${slot}` : slot})`,
    data: offerExpandToken(profileId, date),
    row: "offer-tail",
  };
}

// The EXPANDED tail: one log button per offered item, then a collapse button.
//
// Each log button reuses the `prn:` token the /dose command already uses, so there is
// ONE administration-logging path on Telegram rather than a parallel one that could
// drift on outcome handling or profile re-resolution. `token` is the caller's
// nonce-maker (a random suffix keeps two rebuilt keyboards from colliding).
export function expandedOfferActions(
  profileId: number,
  date: string,
  items: readonly OfferedItem[],
  token: () => string
): NotificationAction[] {
  const actions: NotificationAction[] = items.map((it) => ({
    label:
      `${GLYPH.dose} ${it.name}` +
      (it.detail ? ` · ${it.detail}` : "") +
      (it.countToday > 0 ? ` (${it.countToday} today)` : ""),
    data: `prn:${profileId}:${it.itemId}:${token()}`,
    row: `offer-${it.itemId}`,
  }));
  actions.push({
    label: "▲ Collapse",
    data: offerCollapseToken(profileId, date),
    row: "offer-tail",
  });
  return actions;
}

// The plain-text tail for channels that CANNOT edit a message in place (Web Push,
// Home Assistant). They get an honest count instead of an interactive expansion —
// a button that can't expand would be a lie, and a second message would be a send
// the user never consented to.
//
// It NAMES THE NOUN since #1712: "+3 available when you want them" never said
// available WHAT, and on Telegram — where the button already names all three items —
// it was a redundant duplicate of the control beside it. The Telegram body drops the
// line entirely (the button carries it, self-describing); these channels, which have
// no button, keep it in words. The #1505 honest-count-for-non-interactive-channels
// principle survives; only the duplicate goes.
export function offerTextTail(count: number): string | null {
  if (count <= 0) return null;
  return `${count} more supplement${count === 1 ? "" : "s"} you can log any time`;
}

// Whether the collapsed tail's LABEL is now stale — i.e. the slot turned over since
// the keyboard was rendered. The tick calls this before editing so a boundary pass
// that changes nothing performs no API call at all (an edit Telegram would answer
// "message is not modified" is still a request, and this stays cheap by not making
// it).
export function offerTailNeedsRefresh(
  renderedAtHhmm: string,
  nowHhmm: string
): boolean {
  return currentTimeBucket(renderedAtHhmm) !== currentTimeBucket(nowHhmm);
}
