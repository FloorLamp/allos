// The "➕ Doses" OFFER TAIL (issue #1505 Part 1, class 3: user-initiated access).
// Pure — no DB, no network — so the slot-scoping rule is unit-testable on its own.
//
// THE PROBLEM IT SOLVES. `may` items are never pushed, by design. For a user who
// lives in the app that is fine — the Supplements page and quick log are always
// there. For a TAP-ONLY user (the owner's own posture: inline keyboards on pushed
// messages, no typing) "never pushed" would mean "unreachable", and an unreachable
// item is a deleted item with extra steps. So the daily digest — the one message that
// arrives regardless — carries a guaranteed access path as its FIRST inline button.
//
// THE SHAPE. Collapsed by default: one button, naming what it opens and how much is on
// offer ("➕ Doses (2)"). Tapping expands it IN PLACE into one-tap log buttons for
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

import { currentTimeBucket } from "../intake-schedule";
import { intakeShortLabels } from "../intake-short-name";
import type { IntakeItemKind } from "../types";
import { DIGEST_TAIL_ROW, type NotificationAction } from "./types";
import { GLYPH } from "./glyphs";

// One may item as the tail renders it: enough to label a button and log a dose.
export interface OfferedItem {
  itemId: number;
  name: string;
  // Kind + product feed the short-label fallback: a supplement's shorter product
  // name may stand in for a long composition-style name; a medication's product
  // is a formulation and never does (it already rides `detail` there).
  kind?: IntakeItemKind;
  product?: string | null;
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

// The COLLAPSED tail: one button, naming what it opens and how much is behind it.
//
// THE LABEL NAMES THE THING (#2890). "Log other" came from #1819 item 8, set on the
// principle that a label should say what tapping does; it fixed the cryptic separators
// of "➕ Log other… · midday (3)" but kept a vague noun — other than WHAT? The digest
// need not name a single dose, so "other" was relative to something the reader may not
// be able to see. What the button opens is this profile's `may` supplements and PRN
// medications, and the app's own word for both is DOSES (the `/dose` command,
// `intake_item_logs`, GLYPH.dose on every expanded row). Paired with "⚙️ Tune" on one
// row, a noun also reads better than a second competing verb.
//
// THE SLOT WORD IS GONE; THE SLOT RULE IS NOT. The expansion is still scoped at TAP
// time against the profile-local clock, and the tick still re-labels at each boundary
// (`offerTailNeedsRefresh` below) — the COUNT is slot-dependent even though the label no
// longer says the word. The slot name was the least useful third of a label the reader
// had to decode, and the expansion explains itself the moment it opens.
//
// Zero on offer drops the parenthetical rather than rendering "(0)": no count is not a
// count of none.
//
// THE NOUN IS DIGEST-ONLY, and that is not a detail — see `reminderOfferAction` below.
// Every argument above for dropping "other" is an argument about the DIGEST, where the
// referent may be invisible. On the dose reminder it is visible, and a bare count there
// collides with the reminder's own.
export function collapsedOfferAction(
  profileId: number,
  date: string,
  count: number
): NotificationAction {
  return {
    label: `${GLYPH.more} Doses${count > 0 ? ` (${count})` : ""}`,
    data: offerExpandToken(profileId, date),
    // Shared with ⚙️ Tune so the two collapsed controls occupy ONE row (#2890).
    row: DIGEST_TAIL_ROW,
  };
}

// The SAME control on the DOSE REMINDER's ride-along row (#1505 Part 1, class 3) —
// which keeps the word "other", deliberately.
//
// TWO COUNTS ON ONE KEYBOARD IS THE FAILURE THIS AVOIDS. The reminder already carries
// "✅ All (N)" over the doses it is reminding about; putting "➕ Doses (3)" beside it
// puts two dose counts on one keyboard that mean different things and cannot be added
// up — "2 still due here" and "3 you may log any time".
//
// #2890's whole argument for dropping "other" was that the DIGEST need not name a
// single dose, so the noun was relative to something invisible. On the reminder the
// referent is right there: the message IS the list these are other than. The word does
// the work it was always meant to do, and only here.
//
// The slot word stays gone for the reason it went everywhere else, and more so — the
// reminder IS the slot, so naming it would be the message repeating itself.
export function reminderOfferAction(
  profileId: number,
  date: string,
  count: number
): NotificationAction {
  return {
    label: `${GLYPH.more} Log other${count > 0 ? ` (${count})` : ""}`,
    data: offerExpandToken(profileId, date),
    // No shared row key: there is no ⚙️ Tune on a reminder to pair with, and this
    // control has always had the row to itself here.
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
  // Resolved over the offered set this keyboard renders (#2858 review): every
  // button here logs an administration, so two that read alike over two different
  // item ids is a wrong-subject tap.
  const buttonLabels = intakeShortLabels(items);
  const actions: NotificationAction[] = items.map((it, i) => ({
    label:
      `${GLYPH.dose} ${buttonLabels[i]}` +
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
