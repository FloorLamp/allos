"use client";

import { useState, useTransition } from "react";
import {
  digestTimeSuggestionCopy,
  DIGEST_TIME_STALE_TEXT,
  type DigestTimeSuggestion,
} from "@/lib/digest-time-suggestion";
import { formatNotifyTime } from "@/lib/notifications/schedule";
import type { TimeFormat } from "@/lib/format-date";
import Button from "@/components/Button";
import { Notice } from "@/components/Notice";
import {
  applyDigestTimeSuggestion,
  switchDigestToDynamic,
  dismissDigestTimeSuggestion,
} from "../profile/actions";

// The digest time suggestion's PRIMARY surface (#2217): beside the digest time, where
// the setting is, so the fix is one tap from the fact. A rendered aggregate on a page
// the user opened — class 2 in the attention doctrine, no consent question.
//
// It states the measured facts and nothing about the person (#992/#716): two clock
// times, what follows from them, and what they were measured over. No "you should", no
// streak, no judgement — and no adjective anywhere, which is why it renders as calm
// body text rather than as a warning banner.
//
// THREE EXITS, ALL EXPLICIT. Switch to the mode that waits for the data, use the
// proposed time, or decline. Declining is FIRST CLASS: it dismisses the episode, not
// today's rendering, and the same key silences the digest's own line (constraint 5).
//
// DYNAMIC LEADS (#2255 §2). It used to be the ghost beside a primary "Use 07:40",
// which recommended the shallower remedy by button colour: bumping the static time
// costs the user the full gap every morning, while "As soon as it's ready" keeps the
// current time as its floor, usually sends earlier than the proposal, and is
// deadline-bounded. Static-later wins only on PREDICTABILITY — so the copy now says
// that (`copy.tradeoff`, two clock times, no adjectives) rather than leaving the
// ranking asserted by styling. The in-digest keyboard carries the same order.
//
// TWO QUIET PEERS PLUS A LINK (#4978 owner ruling 14, 2026-09-10, superseding
// #2255's ruling ON THIS MOUNT ONLY). #2255 ranked the two remedies by giving them
// two different button weights — `btn` for the mode switch, `btn-ghost` for "Use
// <proposed>" — because the app then had two quiet weights to rank with. The
// convergence folds ghost into the one secondary and deletes that premise, and the
// only way to keep a visible ranking would be to fill the mode switch: a loud
// control on an advisory Notice inside a card with no commit of its own, which is
// the shape rulings 7 and 11 each declined. So the two remedies are peers, and the
// ranking lives where it already reads in words — `copy.tradeoff`, two clock times,
// no adjectives. The in-digest keyboard carries the same order.
//
// The decline is UNTOUCHED by that ruling and stays outside the button vocabulary,
// on the muted text link the Notice family already uses for a decline
// (`DraftRestoreBanner`'s "Discard"): an exit should not compete visually with the
// two choices it is an exit from. It stays a <button>: same dismiss action,
// focusable and activated by Enter AND Space, which an href-less <a> is not.
//
// Nothing here carries the proposed minute into the write. Each action re-resolves the
// live suggestion server-side, so a tab left open across a week of drifting statistics
// can only ever write what the detector currently proposes — or refuse and say so.
export default function DigestTimeSuggestionRow({
  suggestion,
  timeFormat,
  onApplied,
}: {
  suggestion: DigestTimeSuggestion;
  // The reader's clock convention (#964/#1163). DISPLAY only — the write below still
  // posts the canonical "HH:MM" the settings tier stores.
  timeFormat: TimeFormat;
  // Fold an accepted write into the form's local field bag, so the time input beside
  // this row shows what was just stored instead of drifting from it. It does NOT
  // re-save: the action already wrote, and posting the whole schedule back would be a
  // second write the user never asked for.
  onApplied: (patch: Record<string, string>) => void;
}) {
  const copy = digestTimeSuggestionCopy(suggestion, timeFormat);
  const [pending, start] = useTransition();
  const [refusal, setRefusal] = useState<string | null>(null);

  function run(
    action: () => Promise<{ ok: boolean }>,
    applied: Record<string, string>
  ) {
    setRefusal(null);
    start(async () => {
      const result = await action();
      if (result.ok) onApplied(applied);
      else setRefusal(DIGEST_TIME_STALE_TEXT);
    });
  }

  return (
    // SLATE, not amber. The tone map's tinted tones read as warnings, and a send time
    // that predates its data is neither a warning nor a failure — toning it as one
    // would be exactly the editorialising the tone contract forbids (#992/#716).
    <Notice tone="slate" testid="digest-time-suggestion" className="mt-2">
      <p>
        {copy.headline} {copy.detail}
      </p>
      <p className="mt-1">{copy.tradeoff}</p>
      <p className="mt-0.5 text-xs opacity-80">{copy.evidence}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          disabled={pending}
          data-testid="digest-time-dynamic"
          onClick={() => run(switchDigestToDynamic, { digest_mode: "dynamic" })}
        >
          {copy.dynamicLabel}
        </Button>
        <Button
          disabled={pending}
          data-testid="digest-time-use"
          onClick={() =>
            run(applyDigestTimeSuggestion, {
              // The STORED vocabulary, not the reader's clock: this posts the value
              // the settings tier persists and the time input holds.
              digest_hour: formatNotifyTime(suggestion.proposedMinute),
            })
          }
        >
          {copy.useLabel}
        </Button>
        <button
          type="button"
          className="font-medium opacity-70 underline-offset-2 hover:underline disabled:opacity-50"
          disabled={pending}
          data-testid="digest-time-dismiss"
          onClick={() => run(dismissDigestTimeSuggestion, {})}
        >
          {copy.dismissLabel}
        </button>
      </div>
      {refusal && (
        <p className="mt-2 text-xs" data-testid="digest-time-refusal">
          {refusal}
        </p>
      )}
    </Notice>
  );
}
