import { describe, expect, it } from "vitest";
import { portalLoginStatus, type PortalRunLike } from "../portal-status";

// PURE TIER (#1756, reshaped by #1874). Each portal login row's last-run sentence.
//
// #1756's page-level status sentence retired with the #1874 redesign: a run belongs to a
// LOGIN, so its status renders on the login's own row, from that login's own last
// report. What this pins is the tone/text contract per branch — including that a
// nothing-new run still reads as a check (a quiet week is healthy, not broken) and that
// the tool's free-text failure message is carried into the sentence (it renders as
// text; the scoping tests in the DB tier prove who may ever receive it).

function report(over: Partial<PortalRunLike> = {}): PortalRunLike {
  return {
    at: "2026-03-04 05:06:07",
    ok: true,
    message: null,
    ...over,
  };
}

describe("portalLoginStatus", () => {
  it("is honestly idle for a login that has never reported", () => {
    expect(portalLoginStatus(null)).toEqual({
      tone: "idle",
      text: "No run reported yet.",
    });
  });

  it("counts a successful run as a check, reduced to its calendar day", () => {
    expect(portalLoginStatus(report())).toEqual({
      tone: "ok",
      text: "Last run 2026-03-04",
    });
  });

  it("carries the tool's failure line, terminated as a sentence", () => {
    const line = portalLoginStatus(
      report({ ok: false, message: "the login page changed" })
    );
    expect(line.tone).toBe("attention");
    expect(line.text).toBe(
      "Last run failed 2026-03-04: the login page changed."
    );
  });

  it("does not double-terminate a message that already ends the sentence", () => {
    expect(
      portalLoginStatus(report({ ok: false, message: "code expired!" })).text
    ).toBe("Last run failed 2026-03-04: code expired!");
  });

  it("still states a failure when the tool sent no message", () => {
    expect(portalLoginStatus(report({ ok: false }))).toEqual({
      tone: "attention",
      text: "Last run failed 2026-03-04.",
    });
  });
});
