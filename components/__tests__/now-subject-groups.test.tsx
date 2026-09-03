import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import NowCards, {
  type NowSubjectLabel,
} from "@/components/dashboard/NowCards";

function mediaQuery(reduced: boolean): MediaQueryList {
  return {
    matches: reduced,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  };
}

beforeEach(() => {
  window.matchMedia = () => mediaQuery(true);
});
afterEach(cleanup);

// ── THE NOW SECTION'S SUBJECT LABELS (#4752 item 6) ─────────────────────────
//
// The ranker's half of this — group by subject, rank within group, null for a
// single subject — is asserted on the sort itself in lib/__tests__/rank-core.test.ts
// and on a real household manifest in the placement-manifest db test. What is left
// is the RENDERED claim the issue makes: a cross-profile Now draws one label per
// cluster and a single-subject Now draws none.
//
// The strip is driven through `node` rows because the label is decided before the
// row's own arm is chosen, so a fact row and a node row reach it identically — and
// a node row needs no candidate/presentation fixture to stand up.

function subject(id: number, name: string): NowSubjectLabel {
  return {
    key: String(id),
    profile: { id, name, photo_path: null, photo_version: 0 },
    name,
  };
}

const DUNE = subject(7, "Dune");
const YOU = subject(2, "You");

function strip(rows: { id: string; subject?: NowSubjectLabel }[]) {
  render(
    <NowCards
      rows={rows.map((row) => ({ ...row, node: <span>{row.id}</span> }))}
    />
  );
  return screen.queryAllByTestId("now-subject-label");
}

// THE NAME, NOT THE NAME PLUS THE AVATAR'S INITIALS. The label draws an `Avatar`
// beside the name and both are inside the same element, so a `textContent` read of
// the whole label says "YYou" — a positive control that concatenation would have
// quietly changed rather than failed on.
const named = (label: Element) =>
  label.querySelector(".section-label")?.textContent;

describe("Now's subject labels", () => {
  it("opens one label per cluster, named and in cluster order", () => {
    const labels = strip([
      { id: "illness-group", subject: DUNE },
      { id: "dune.reading", subject: DUNE },
      { id: "dose.owed", subject: YOU },
      { id: "workout.live", subject: YOU },
    ]);
    // ONE label per cluster — not one per row. A label repeated on Dune's second
    // row would make this four.
    expect(labels.map((label) => label.getAttribute("data-subject"))).toEqual([
      "7",
      "2",
    ]);
    expect(labels.map(named)).toEqual(["Dune", "You"]);
    // Each label stands immediately above its own cluster's first row, so the
    // viewer's Omega-3 reads as theirs rather than as more of a child's illness.
    const items = Array.from(document.querySelectorAll("li")).map(
      (node) => node.getAttribute("data-subject") ?? node.textContent
    );
    expect(items).toEqual([
      "7",
      "illness-group",
      "dune.reading",
      "2",
      "dose.owed",
      "workout.live",
    ]);
  });

  it("draws none when Now holds one subject", () => {
    // The ranker returns null rather than one group, so no row carries a subject —
    // and the rows are the SAME rows the case above labelled, which is what makes
    // this an absence the fixture could have contradicted.
    expect(
      strip([
        { id: "illness-group" },
        { id: "dune.reading" },
        { id: "dose.owed" },
      ])
    ).toEqual([]);
  });

  it("draws none over a cluster it cannot name honestly", () => {
    // The illness group is ONE container holding every ill profile's cockpit, so
    // `DashboardPlacementCanvas` withholds its subject when two profiles are ill —
    // the first one's name over another patient's controls is the mis-attribution
    // #531 made the per-cockpit name a safety feature to prevent. The rows AFTER it
    // still say whose they are.
    const labels = strip([
      { id: "illness-group" },
      { id: "dose.owed", subject: YOU },
    ]);
    expect(labels.map(named)).toEqual(["You"]);
  });
});
