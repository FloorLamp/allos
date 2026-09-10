import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import FromThisVisit from "@/components/visit-links/FromThisVisit";
import type { VisitLinkedRow } from "@/lib/queries";
import type { EncounterFromVisit } from "@/lib/visit-link-suggest";

// THE BULK ACTION IS THE SURFACE'S ONE LOUD CONTROL (#4978, PM ruling 7,
// 2026-09-09 23:45 UTC): "a bulk commit beside per-row commits (`FromThisVisit`'s
// 'Link all') is the surface's one loud control: bulk primary, rows quiet."
//
// The claim is read off the RENDERED classes, never the call site. `variant` reaches
// the paint through `SubmitButton` -> `Button`, and a rank that stopped being
// forwarded there still typechecks and lints — that silent demotion is the defect
// #3982 was written against, so a call-site assertion would pass through it.
//
// The census counts ALL FOUR loud paints, not just the rank classes. `primary` and
// `danger` name themselves, but `duplicate-resolution-primary` and
// `destructive-submit` are wrapper utilities that paint a solid fill onto a
// rank-less child (#5696), so a query for the rank selectors alone under-counts and
// would let a second fill arrive here unseen.

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

/** Every loud control on the surface — all four paints that render a solid fill. */
function loudIn(surface: HTMLElement): string[] {
  return Array.from(
    surface.querySelectorAll(
      ".button-control-primary, .button-control-danger, .duplicate-resolution-primary > .button-control, .destructive-submit > .button-control"
    ),
    (el) => (el.textContent ?? "").trim()
  );
}

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
