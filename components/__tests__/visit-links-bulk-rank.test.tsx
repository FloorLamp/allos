import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FromThisVisit from "@/components/visit-links/FromThisVisit";
import type { VisitLinkedRow } from "@/lib/queries";
import type { EncounterFromVisit } from "@/lib/visit-link-suggest";
import { loudIn } from "./loud-controls";

// THE BULK ACTION IS THE SURFACE'S ONE LOUD CONTROL (#4978, PM ruling 7,
// 2026-09-09 23:45 UTC): "a bulk commit beside per-row commits (`FromThisVisit`'s
// 'Link all') is the surface's one loud control: bulk primary, rows quiet."
//
// The claim is read off the RENDERED classes, never the call site. `variant` reaches
// the paint through `SubmitButton` -> `Button`, and a rank that stopped being
// forwarded there still typechecks and lints — that silent demotion is the defect
// #3982 was written against, so a call-site assertion would pass through it.
//
// The census comes from `./loud-controls`, the one definition of a loud control
// (#5696). This file used to widen its own selector list to reach past the two
// wrapper utilities that painted a fill onto a rank-LESS child; those wrappers now
// state their rank on the button, so the rank classes are the whole census and a
// second fill arriving here cannot hide behind a wrapper.

vi.mock("@/app/(app)/visit-link-actions", () => ({
  linkAllFromVisitAction: async () => {},
  dismissAllFromVisitAction: async () => {},
  linkRecordVisitAction: async () => {},
  declineRecordVisitAction: async () => {},
  unlinkRecordVisitAction: async () => {},
}));

afterEach(cleanup);

const linkedRows: VisitLinkedRow[] = [
  {
    domain: "procedure",
    id: 11,
    label: "Knee arthroscopy",
    date: "2026-03-04",
  },
];

const suggestions: EncounterFromVisit = {
  suggestions: [
    {
      record: {
        domain: "medication",
        id: 21,
        external_id: null,
        date: "2026-03-04",
        providerId: 7,
        label: "Amoxicillin",
      },
      confidence: "strong",
    },
    {
      record: {
        domain: "imaging",
        id: 22,
        external_id: null,
        date: "2026-03-04",
        providerId: null,
        label: "Chest X-ray",
      },
      confidence: "medium",
    },
  ],
};

describe("the visit-links bulk action takes the rank the doctrine gives it", () => {
  it("fills 'Link all' and nothing else on the card it sits in", () => {
    render(
      <div className="card" data-testid="encounter-detail-card">
        <FromThisVisit
          profileId={1}
          encounterId={2}
          linkedRows={linkedRows}
          suggestions={suggestions}
        />
      </div>
    );

    const linkAll = screen.getByTestId("link-all-from-visit");
    expect(linkAll.className).toContain("button-control-primary");
    expect(loudIn(screen.getByTestId("encounter-detail-card"))).toEqual([
      "Link all",
    ]);
  });

  it("keeps every per-row Link and Dismiss quiet beside it", () => {
    render(
      <FromThisVisit
        profileId={1}
        encounterId={2}
        linkedRows={linkedRows}
        suggestions={suggestions}
      />
    );

    // One pair per suggestion row, and the bulk commit is the only rank on the
    // section — the "rows quiet" half of ruling 7, which a later lane finishing
    // the per-row commits by mistake would break here.
    const rows = screen.getAllByRole("button", { name: "Link" });
    expect(rows).toHaveLength(suggestions.suggestions.length);
    for (const row of rows) {
      expect(row.className).toContain("button-control");
      expect(row.className).not.toContain("button-control-primary");
    }
    for (const row of screen.getAllByRole("button", { name: "Dismiss" })) {
      expect(row.className).not.toContain("button-control-primary");
    }
  });
});
