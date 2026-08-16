import { describe, expect, it } from "vitest";
import { portalLoginStatus, type PortalRunLike } from "../portal-status";

// PURE TIER (#1756, reshaped by #1874, extended by #2914). Each portal login row's
// last-run sentence.
//
// #1756's page-level status sentence retired with the #1874 redesign: a run belongs to a
// LOGIN, so its status renders on the login's own row, from that login's own last
// report. What this pins is the tone/text contract per branch — including that a
// nothing-new run still reads as a check (a quiet week is healthy, not broken) and that
// the tool's free-text failure message is carried into the sentence (it renders as
// text; the scoping tests in the DB tier prove who may ever receive it).
//
// #2914 adds the DELIVERY branches: a `contacted: false` report names the run kind and
// the delivered document count (linked into Data → Review), and states the login's real
// check clock whenever that clock lags the delivery.

function report(over: Partial<PortalRunLike> = {}): PortalRunLike {
  return {
    at: "2026-03-04 05:06:07",
    ok: true,
    message: null,
    contacted: true,
    checkedAt: "2026-03-04 05:06:07",
    ...over,
  };
}

// A delivery-only push: it opened no portal, so its check clock is whatever the last
// real visit left standing.
function delivery(over: Partial<PortalRunLike> = {}): PortalRunLike {
  return report({ contacted: false, checkedAt: null, delivered: 4, ...over });
}

describe("portalLoginStatus", () => {
  it("is honestly idle for a login that has never reported", () => {
    expect(portalLoginStatus(null)).toEqual({
      tone: "idle",
      text: "No run reported yet.",
      segments: [{ kind: "text", text: "No run reported yet." }],
    });
  });

  it("counts a successful run as a check, reduced to its calendar day", () => {
    const line = portalLoginStatus(report());
    expect(line.tone).toBe("ok");
    expect(line.text).toBe("Last run 2026-03-04");
    expect(line.segments).toEqual([
      { kind: "text", text: "Last run 2026-03-04" },
    ]);
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
    const line = portalLoginStatus(report({ ok: false }));
    expect(line.tone).toBe("attention");
    expect(line.text).toBe("Last run failed 2026-03-04.");
  });

  it("keeps the plain text and the segments in agreement on every branch", () => {
    for (const r of [
      null,
      report(),
      report({ ok: false, message: "nope" }),
      delivery(),
      delivery({ delivered: 0 }),
      delivery({ checkedAt: "2026-03-01 09:00:00" }),
    ]) {
      const line = portalLoginStatus(r);
      expect(line.segments.map((s) => s.text).join("")).toBe(line.text);
    }
  });
});

// ── The delivery branches (#2914) ────────────────────────────────────────────

describe("portalLoginStatus — a delivery is not a run", () => {
  it("names the run kind and the delivered document count", () => {
    const line = portalLoginStatus(
      delivery({ checkedAt: "2026-03-01 09:00:00" })
    );
    expect(line.tone).toBe("ok");
    expect(line.text).toBe(
      "Delivered 4 documents 2026-03-04 · portal last checked 2026-03-01"
    );
  });

  it("links the count — and only the count — at Data → Review", () => {
    const line = portalLoginStatus(
      delivery({ checkedAt: "2026-03-01 09:00:00" })
    );
    expect(line.segments).toEqual([
      { kind: "text", text: "Delivered " },
      { kind: "link", text: "4 documents", href: "/data?section=review" },
      { kind: "text", text: " 2026-03-04 · portal last checked 2026-03-01" },
    ]);
  });

  it("says document, singular, for a one-document delivery", () => {
    expect(portalLoginStatus(delivery({ delivered: 1 })).text).toBe(
      "Delivered 1 document 2026-03-04 · portal never checked"
    );
  });

  it("states that the portal has never been checked when it never has", () => {
    expect(portalLoginStatus(delivery()).text).toBe(
      "Delivered 4 documents 2026-03-04 · portal never checked"
    );
  });

  it("stays silent about the check clock when a real check landed the same day", () => {
    // Today's delivery beside today's genuine visit — nothing lags, so restating the
    // date the sentence already carries would be noise.
    expect(
      portalLoginStatus(delivery({ checkedAt: "2026-03-04 01:00:00" })).text
    ).toBe("Delivered 4 documents 2026-03-04");
  });

  it("still names the kind when the delivery brought nothing new, and links nothing", () => {
    const line = portalLoginStatus(
      delivery({ delivered: 0, checkedAt: "2026-03-01 09:00:00" })
    );
    expect(line.text).toBe(
      "Delivered no documents 2026-03-04 · portal last checked 2026-03-01"
    );
    expect(line.segments.every((s) => s.kind === "text")).toBe(true);
  });

  it("treats a missing count as nothing to state rather than inventing one", () => {
    const { delivered: _drop, ...noCount } = delivery();
    expect(portalLoginStatus(noCount).text).toBe(
      "Delivered no documents 2026-03-04 · portal never checked"
    );
  });

  it("keeps a FAILED delivery on the failure branch — a push that broke is not a delivery", () => {
    const line = portalLoginStatus(
      delivery({ ok: false, message: "disk full" })
    );
    expect(line.tone).toBe("attention");
    expect(line.text).toBe("Last run failed 2026-03-04: disk full.");
  });

  it("never says 'checked' from a delivery-advanced stamp", () => {
    // The word may appear ONLY as the login's own check clock, and only in the two
    // forms that read it (`portal last checked` / `portal never checked`).
    const line = portalLoginStatus(delivery({ checkedAt: null }));
    expect(line.text).toContain("portal never checked");
    expect(line.text).not.toContain("Last checked");
  });
});
