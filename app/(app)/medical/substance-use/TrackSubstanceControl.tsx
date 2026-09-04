"use client";

import { useState, type FormEvent } from "react";
import { useToast } from "@/components/Toast";
import AddEntryPanel from "@/components/AddEntryPanel";
import { substanceNameError, validateSubstanceName } from "@/lib/substance-use";
import { trackSubstanceUseAction } from "./actions";
import SubmitButton from "@/components/SubmitButton";

// THE ENTRY POINT FOR A CUSTOM SUBSTANCE (#3326, part 2 of #3279).
//
// #3323 shipped the entire custom vocabulary — normalize, resolve, label, the ledger
// carrying a typed name end to end through log, undo, week state, trend, correction,
// cap and finding — and NOTHING IN THE APP COULD REACH IT. This is the missing door.
//
// ── There is no create step, because there is nothing to create ───────────────
//
// A custom substance's identity IS its normalized name in the ledger. It has no
// registration row and no table of its own, so a "create" button would be a button
// that writes nothing and then a second button to log. One field, one tap: naming it
// and logging the first use are the same act. The card appears underneath on the
// revalidation, already carrying the one-tap log/undo, the history, the trend and the
// cap affordance every curated substance has — because it is the same card.
//
// ── The 60-character cap is REFUSED, never trimmed ────────────────────────────
//
// Deliberately no `maxLength` on the input. The browser would swallow the 61st
// keystroke and clip a paste without a word, which is silent truncation wearing a
// nicer hat — and the name someone half-typed is not the name they meant. The check
// runs on submit through the SAME `validateSubstanceName` the Server Action re-runs
// (a Server Action is independently POST-callable), so the two say one sentence.
//
// ── The input is UNCONTROLLED on purpose ──────────────────────────────────────
//
// Its value is read from the submitted FormData, not from React state. A controlled
// input here would make every pre-hydration `fill()` in a spec a silently stale save:
// the value lands on the DOM node, React takes ownership on hydrate and reverts it,
// and the form posts an empty name while the test reads as if it typed one (the
// `settledFill` hazard, e2e/helpers.ts). Nothing here needs the keystrokes.
//
// ── Case is decided on the SERVER, and this surface still types verbatim ──────
//
// #3325 stopped case deciding identity in BOTH this vocabulary and the symptom
// vocabulary it was borrowed from — folding one alone would have re-forked the model
// #3323 unified. The fold needs the profile's own spellings, which a client component
// cannot read, so `trackSubstanceUseAction` resolves the typed name against them: a
// typed "kratom" joins the existing "Kratom" card rather than opening a second ledger.
//
// This surface therefore still sends exactly what was typed, and the pre-flight below
// stays the length/empty gate it always was. The toast already names what ACTUALLY
// landed (`result.label`), which is what keeps the fold from being silent — type
// "kratom", and it says "Kratom: 1 logged today".
//
// Whether a substance survives going to zero (#3324) is likewise not answered here:
// logging-is-creating is the contract this door opens onto, whatever the ledger later
// decides about keeping a substance somebody stopped using.
export default function TrackSubstanceControl() {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Captured BEFORE the await: `currentTarget` is null by the time the action
    // settles, and the reset below needs the real form.
    const form = event.currentTarget;
    const typed = String(new FormData(form).get("name") ?? "");

    const name = validateSubstanceName(typed);
    if (!name.ok) {
      setError(substanceNameError(name.reason));
      return;
    }

    setPending(true);
    const fd = new FormData();
    fd.set("name", typed);
    const result = await trackSubstanceUseAction(fd);
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    form.reset();
    // Names what actually landed rather than what was typed: "Alcohol" resolves onto
    // the curated key, so its drink joins the Alcohol card instead of opening a second
    // ledger, and the person is told so rather than hunting for a card that never came.
    toast(`${result.label}: 1 logged today.`);
  }

  return (
    <AddEntryPanel
      label="Track another substance"
      panelId="track-substance-panel-body"
      testId="track-substance-panel"
    >
      <form
        className="space-y-3"
        onSubmit={(event) => void submit(event)}
        data-testid="track-substance-form"
      >
        <label className="block text-sm">
          Substance name
          <input
            type="text"
            name="name"
            autoComplete="off"
            className="input mt-1 w-full"
            placeholder="Kratom, kava, caffeine…"
            data-testid="track-substance-name"
          />
        </label>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Counted in uses — one use is one session, whatever the form. Logging
          it is what starts tracking it.
        </p>
        {error ? (
          <p
            className="text-sm text-rose-600 dark:text-rose-400"
            data-testid="track-substance-error"
          >
            {error}
          </p>
        ) : null}
        <SubmitButton disabled={pending} data-testid="track-substance-save">
          {pending ? "Logging…" : "Log a use"}
        </SubmitButton>
      </form>
    </AddEntryPanel>
  );
}
