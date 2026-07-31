import { describe, expect, it } from "vitest";
import {
  portalStatusLine,
  type PortalRunReportLike,
  type PortalStatusInput,
} from "../portal-status";

// PURE TIER (#1756). The Patient portals card's Status sentence.
//
// The bug this pins: the card promises "the tool reports every run, so a quiet week reads
// as healthy rather than broken", and the FIRST run then broke it — that run's patient is
// not bound yet, so its report is refused, no profile-scoped sync event lands, and Status
// said "No run reported yet." above a list of patients that same run had just reported.

function report(over: Partial<PortalRunReportLike> = {}): PortalRunReportLike {
  return {
    portalName: "Ochsner MyChart",
    accountName: "Default login",
    accountImplicit: true,
    at: "2026-03-04 05:06:07",
    ok: true,
    message: null,
    discovered: 0,
    ...over,
  };
}

function input(over: Partial<PortalStatusInput> = {}): PortalStatusInput {
  return {
    lastSuccessAt: null,
    connected: false,
    reports: [],
    pending: [],
    ...over,
  };
}

describe("portalStatusLine — nothing has happened yet", () => {
  it("says so plainly when nothing really has", () => {
    expect(portalStatusLine(input())).toEqual({
      tone: "idle",
      text: "No run reported yet.",
    });
  });

  it("distinguishes set-up-but-silent from never-set-up", () => {
    expect(portalStatusLine(input({ connected: true })).text).toBe(
      "Set up, but no run reported yet."
    );
  });
});

describe("portalStatusLine — FIRST CONTACT is no longer a dead zone", () => {
  it("names what the tool reported and what to do about it", () => {
    // The exact sequence from the walkthrough: an authenticated run enumerated three
    // proxy patients, its own patient was unmapped so the report was refused, and no
    // sync event exists. The card must not claim nothing happened.
    const line = portalStatusLine(
      input({
        reports: [report({ discovered: 3 })],
        pending: [
          { portalName: "Ochsner MyChart" },
          { portalName: "Ochsner MyChart" },
          { portalName: "Ochsner MyChart" },
        ],
      })
    );
    expect(line.tone).toBe("attention");
    expect(line.text).toBe(
      "The tool reported 3 patients on Ochsner MyChart — map them below to finish setup."
    );
  });

  it("holds for a single patient, and for a household with two portals", () => {
    expect(
      portalStatusLine(input({ pending: [{ portalName: "Baptist Health" }] }))
        .text
    ).toBe(
      "The tool reported 1 patient on Baptist Health — map that patient below to finish setup."
    );
    expect(
      portalStatusLine(
        input({
          pending: [
            { portalName: "Ochsner MyChart" },
            { portalName: "Baptist Health" },
            // A second row on the first portal names it once, not twice.
            { portalName: "Ochsner MyChart" },
          ],
        })
      ).text
    ).toContain("on Ochsner MyChart, Baptist Health");
  });

  it("does not fire once the profile has a real check behind it", () => {
    // A NEW unmapped patient beside a healthy mapped one is the amber card's business,
    // not Status's — Status answers "when was this last checked".
    const line = portalStatusLine(
      input({
        lastSuccessAt: "2026-03-05 06:07:08",
        pending: [{ portalName: "Ochsner MyChart" }],
      })
    );
    expect(line).toEqual({
      tone: "ok",
      text: "Last checked 2026-03-05 06:07:08.",
    });
  });

  it("says a run happened even with nothing left to map", () => {
    // Everything on that login is ignored, or belongs to another profile. "No run
    // reported yet" would repeat the original lie in miniature.
    const line = portalStatusLine(input({ reports: [report()] }));
    expect(line.tone).toBe("idle");
    expect(line.text).toBe(
      "The tool reported a run on Ochsner MyChart on 2026-03-04, but nothing has been checked for this profile yet."
    );
  });
});

describe("portalStatusLine — a portal-level failure", () => {
  it("surfaces the tool's own message, with attention", () => {
    const line = portalStatusLine(
      input({
        reports: [report({ ok: false, message: "portal login page changed" })],
      })
    );
    expect(line.tone).toBe("attention");
    expect(line.text).toBe(
      "The last run on Ochsner MyChart failed: portal login page changed."
    );
  });

  it("still reports a failure that carried no message", () => {
    expect(
      portalStatusLine(input({ reports: [report({ ok: false })] })).text
    ).toBe("The last run on Ochsner MyChart failed.");
  });

  it("names the LOGIN once one is worth naming", () => {
    expect(
      portalStatusLine(
        input({
          reports: [
            report({
              ok: false,
              accountImplicit: false,
              accountName: "Mom",
            }),
          ],
        })
      ).text
    ).toBe("The last run on Ochsner MyChart (Mom) failed.");
  });

  it("does not double the tool's own full stop", () => {
    expect(
      portalStatusLine(
        input({ reports: [report({ ok: false, message: "it broke." })] })
      ).text
    ).toBe("The last run on Ochsner MyChart failed: it broke.");
  });

  it("beats an OLDER success, and yields to a NEWER one", () => {
    const failure = report({ ok: false, at: "2026-03-04 05:06:07" });
    expect(
      portalStatusLine(
        input({ reports: [failure], lastSuccessAt: "2026-03-03 00:00:00" })
      ).tone
    ).toBe("attention");
    // Recovered: the honest answer to "how long since this was read" is the success.
    expect(
      portalStatusLine(
        input({ reports: [failure], lastSuccessAt: "2026-03-05 00:00:00" })
      )
    ).toEqual({ tone: "ok", text: "Last checked 2026-03-05 00:00:00." });
  });

  it("reads the NEWEST report when several logins have reported", () => {
    const line = portalStatusLine(
      input({
        reports: [
          report({ at: "2026-03-01 00:00:00", ok: false, message: "old news" }),
          report({
            at: "2026-03-09 00:00:00",
            accountImplicit: false,
            accountName: "Dad",
          }),
        ],
      })
    );
    // The newest is a success, so no failure line — and the stale failure is not
    // resurrected just because it is still stored.
    expect(line.tone).toBe("idle");
    expect(line.text).toContain("Ochsner MyChart (Dad)");
  });
});
