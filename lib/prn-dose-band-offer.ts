// THE DOSE-BAND UPDATE OFFER AS THE SERVER STILL SEES IT (issue #5538) — the answer
// path's re-check.
//
// A child's dose row offers to rewrite a stored dose the label band has outgrown, and
// both taps carry only the suppression key the row rendered. This re-derives the offer
// from live rows and the subject's current weight, so a card left open across a weight
// entry, a dose edit or another device's answer refuses instead of writing a figure
// nobody is being shown — the discipline `answerOffer` applies to a family's trigger.
//
// It reads the same quick-log row every dose surface bands from and the same pediatric
// context those surfaces render with, so the key it computes cannot disagree with the
// one the row rendered.

import {
  getPediatricFormContext,
  getPrnIntakeItemsForQuickLog,
} from "./queries";
import { prnDoseUpdateOffer, type PrnDoseUpdateOffer } from "./prn-dosing";

export function standingDoseUpdateOffer(
  profileId: number,
  itemId: number
): PrnDoseUpdateOffer | null {
  const item = getPrnIntakeItemsForQuickLog(profileId).find(
    (row) => row.id === itemId
  );
  return item
    ? prnDoseUpdateOffer(
        {
          id: item.id,
          name: item.displayName,
          identity: item.identity,
          product: item.product,
          amount: item.amount,
        },
        getPediatricFormContext(profileId)
      )
    : null;
}
