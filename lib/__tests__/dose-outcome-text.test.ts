import { describe, expect, it } from "vitest";
import { doseConfirmMessage, doseResolved } from "@/lib/dose-outcome-text";
import { tapAnswerText } from "@/lib/notifications/callback-data";
import type { DoseTakenOutcome } from "@/lib/types";

// The in-app dose-confirm wording (issue #1468). The rule under test is the one
// the DoseTakenOutcome union exists for: a confirm NEVER unconditionally
// confirms.

const ALL: DoseTakenOutcome[] = [
  "logged",
  "skipped",
  "already-taken",
  "already-skipped",
  "stale-dose",
  "inactive",
];

// The outcomes where markDoseTaken wrote NOTHING for a "mark taken" tap, so the
// surface must not claim the dose was logged.
const WROTE_NOTHING: DoseTakenOutcome[] = [
  "already-skipped",
  "stale-dose",
  "inactive",
];

describe("doseConfirmMessage", () => {
  it("answers every outcome with a non-empty message", () => {
    for (const outcome of ALL) {
      expect(doseConfirmMessage(outcome).text.length).toBeGreaterThan(0);
    }
  });

  it("never claims a dose was logged when nothing was written", () => {
    // The #280 defect, held down: a dose retired by a schedule edit, an item
    // since paused, or a dose standing as SKIPPED all log nothing on a ✅ tap.
    for (const outcome of WROTE_NOTHING) {
      const { text, tone } = doseConfirmMessage(outcome);
      expect(text.toLowerCase()).toContain("not logged");
      expect(tone).toBe("error");
    }
  });

  it("is honest — not alarming — about an idempotent repeat", () => {
    // Re-tapping a dose already taken wrote nothing either, but the world is
    // exactly as the user wants it, so this is not an error.
    const repeat = doseConfirmMessage("already-taken");
    expect(repeat.tone).toBe("success");
    expect(repeat.text.toLowerCase()).toContain("already");
    expect(doseConfirmMessage("logged").tone).toBe("success");
  });

  it("names the status that actually stands for an already-skipped dose", () => {
    // Never let the ✅ button confirm its own action against the ⏭ log.
    expect(doseConfirmMessage("already-skipped").text.toLowerCase()).toContain(
      "skipped"
    );
  });

  it("says nothing about opening the app — it IS the app", () => {
    // The seam against lib/notifications/callback-data.ts's Telegram wording,
    // which ends "Open the app to change it". Sharing one string would make one
    // of the two surfaces lie about where its reader is standing; sharing the
    // OUTCOME (which they do) is the part that matters.
    for (const outcome of ALL) {
      expect(doseConfirmMessage(outcome).text).not.toMatch(/open the app/i);
    }
    expect(tapAnswerText("inactive")).toMatch(/open the app/i);
  });
});

describe("doseResolved", () => {
  it("drops the row only when a taken log actually stands", () => {
    expect(doseResolved("logged")).toBe(true);
    expect(doseResolved("already-taken")).toBe(true);
  });

  it("keeps a still-due dose in the list", () => {
    // Nothing was logged, so the dose is still due — removing the row would be
    // the same lie as a false confirmation, just told silently.
    for (const outcome of WROTE_NOTHING) {
      expect(doseResolved(outcome)).toBe(false);
    }
  });
});
