import { describe, expect, it } from "vitest";
import {
  HOVER_THRESHOLDS,
  hoverAuditSections,
  hoverClip,
  summarizeHover,
} from "../../scripts/ux-hover-census.mjs";

// Pure guard for the census's hover rule (#3489 deliverable 4). The rendered
// halves — engine visibility and painted pixels — can only be measured in a
// browser and are guarded in e2e/ux-hover-capture.spec.ts. What is pinned HERE is
// everything downstream of those readings: the no-op decision, the capping, and
// the audit rendering a reviewer actually reads.
//
// The no-op decision is the one worth having a pure test for. It is the difference
// between a contact sheet where every `-hover.png` shows a state that provably
// differs from its default twin, and one where a reader has to open two files to
// find out that nothing happened.

const OPTS = {
  movedEpsilonPx: HOVER_THRESHOLDS.movedEpsilonPx,
  maxElementsPerEntry: HOVER_THRESHOLDS.maxElementsPerEntry,
};

interface El {
  key: string;
  name: string;
  text: string;
  visible: boolean;
  rect: [number, number, number, number];
}

const el = (
  key: string,
  visible: boolean,
  rect: [number, number, number, number] = [0, 0, 10, 10],
  text = ""
): El => ({ key, name: `span#${key}`, text, visible, rect });

const snap = (elements: El[]) => ({ elements, examined: elements.length });

describe("summarizeHover — the rendered difference a hover made", () => {
  it("reports an element that became visible as revealed INFORMATION", () => {
    const r = summarizeHover(
      snap([el("door", false, [0, 0, 60, 16], "Latest")]),
      snap([el("door", true, [0, 0, 60, 16], "Latest")]),
      OPTS,
      true
    );
    expect(r.revealed).toEqual([{ el: "span#door", text: "Latest" }]);
    expect(r.revealedTotal).toBe(1);
    expect(r.changed).toBe(true);
    expect(r.revealsInformation).toBe(true);
  });

  it("reports an element that stopped being visible as hidden", () => {
    // The standing-door exchange: the age steps aside while the door arrives, and
    // a capture that only reported arrivals would document half of it.
    const r = summarizeHover(
      snap([el("age", true, [0, 0, 40, 16], "3 d ago")]),
      snap([el("age", false, [0, 0, 40, 16], "3 d ago")]),
      OPTS,
      true
    );
    expect(r.hidden).toEqual([{ el: "span#age", text: "3 d ago" }]);
    expect(r.revealedTotal).toBe(0);
    expect(r.changed).toBe(true);
    // Hiding something is not revealing information: a reviewer scanning for
    // "what does this hover show me that a static shot cannot" should not be sent
    // to a row whose whole content was a disappearance.
    expect(r.revealsInformation).toBe(false);
  });

  it("counts an element React unmounted as hidden, not as nothing", () => {
    // Reachable only from the BEFORE side — the key is simply gone from the after
    // snapshot, so a diff that walked only the after list would call this a no-op.
    const r = summarizeHover(
      snap([el("row", true, [0, 0, 40, 16], "gone")]),
      snap([]),
      OPTS,
      false
    );
    expect(r.hiddenTotal).toBe(1);
    expect(r.changed).toBe(true);
  });

  it("reports movement past the epsilon and ignores jitter below it", () => {
    const moved = summarizeHover(
      snap([el("door", true, [0, 0, 60, 16])]),
      snap([el("door", true, [4, 0, 60, 16])]),
      OPTS,
      true
    );
    expect(moved.moved).toEqual([{ el: "span#door", byPx: 4 }]);

    const jitter = summarizeHover(
      snap([el("door", true, [0, 0, 60, 16])]),
      snap([el("door", true, [1, 0, 60, 16])]),
      OPTS,
      false
    );
    expect(jitter.movedTotal).toBe(0);
    expect(jitter.changed).toBe(false);
  });

  it("calls a hover that changed NOTHING RENDERED a no-op", () => {
    // The whole reason the shot is skipped. Every one of the four signals is
    // empty, so a `…-hover.png` here would be a byte-identical twin of the default
    // capture sitting in a ~120-frame contact sheet.
    const r = summarizeHover(
      snap([el("a", true), el("b", false)]),
      snap([el("a", true), el("b", false)]),
      OPTS,
      false
    );
    expect(r.changed).toBe(false);
    expect(r.revealsInformation).toBe(false);
    expect([r.revealedTotal, r.hiddenTotal, r.movedTotal]).toEqual([0, 0, 0]);
  });

  it("treats changed pixels alone as a change, but not as information", () => {
    // A row that only tints on hover. Worth a picture — the tint is a real
    // affordance a static shot cannot show — but a reviewer hunting for content
    // that exists nowhere else should be able to skip past it.
    const r = summarizeHover(
      snap([el("a", true)]),
      snap([el("a", true)]),
      OPTS,
      true
    );
    expect(r.changed).toBe(true);
    expect(r.revealsInformation).toBe(false);
  });

  it("keeps the two signals independent in both directions", () => {
    // A payload painted OUTSIDE the clipped region changes no pixels in it — the
    // schedule grid's panel follows the cursor and can land anywhere — so a
    // pixel-only verdict would call this a no-op and skip the one capture in the
    // registry that carries information with no other path to it.
    const r = summarizeHover(
      snap([]),
      snap([el("tip", true, [0, 0, 200, 80], "Tdap")]),
      OPTS,
      false
    );
    expect(r.pixelsChanged).toBe(false);
    expect(r.changed).toBe(true);
    expect(r.revealsInformation).toBe(true);
  });

  it("caps the lists without capping the counts", () => {
    const many = Array.from({ length: 20 }, (_, i) => el(`e${i}`, false));
    const shown = many.map((e) => ({ ...e, visible: true }));
    const r = summarizeHover(snap(many), snap(shown), OPTS, true);
    expect(r.revealedTotal).toBe(20);
    expect(r.revealed).toHaveLength(OPTS.maxElementsPerEntry);
  });
});

describe("hoverClip — the rectangle both PNGs are cut from", () => {
  const page = { pad: 10, pageWidth: 1280, pageHeight: 2000 };

  it("unions the target and its payload, then pads", () => {
    expect(
      hoverClip(
        [
          { x: 100, y: 100, width: 50, height: 20 },
          { x: 400, y: 90, width: 60, height: 20 },
        ],
        page
      )
    ).toEqual({ x: 90, y: 80, width: 380, height: 50 });
  });

  it("ignores a payload that does not exist yet", () => {
    expect(
      hoverClip([{ x: 100, y: 100, width: 50, height: 20 }, null], page)
    ).toEqual({
      x: 90,
      y: 90,
      width: 70,
      height: 40,
    });
  });

  it("clamps to the page rather than throwing the whole entry away", () => {
    // A target at the very edge would otherwise produce a clip Playwright
    // rejects, and a thrown screenshot aborts the entry — which reads in the log
    // exactly like "this surface has no hover state".
    const clip = hoverClip([{ x: 1270, y: 1995, width: 20, height: 20 }], page);
    expect(clip).toEqual({ x: 1260, y: 1985, width: 20, height: 15 });
  });

  it("returns null when there is nothing to cut", () => {
    expect(hoverClip([null, null], page)).toBeNull();
  });
});

describe("hoverAuditSections — how a reviewer meets a hover capture", () => {
  const rows = [
    {
      route: "/",
      label: "Standing family door labels",
      found: true,
      shot: "42-page-desktop-home-hover.png",
      revealed: [{ el: 'span[data-testid="standing-door"]', text: "Latest" }],
      hidden: [{ el: "span#age", text: "3 d ago" }],
      movedTotal: 1,
      pixelsChanged: true,
    },
    {
      route: "/records/history/immunizations",
      label: "CDC schedule grid vaccine tooltip",
      found: true,
      revealed: [],
      hidden: [],
      movedTotal: 0,
      pixelsChanged: false,
    },
    {
      route: "/wellness",
      label: "gone",
      found: false,
      why: "hover target not on this route",
    },
  ];

  it("names the shot file, so the table points AT the picture", () => {
    const md = hoverAuditSections(rows).join("\n");
    expect(md).toContain("42-page-desktop-home-hover.png");
    expect(md).toContain("Latest");
    // …and says out loud that this is a desktop-only artifact, because a reader
    // who does not know that will wonder why there is no phone column.
    expect(md).toContain("Desktop only");
  });

  it("shows a no-op as a row with no shot, and an absent target as a BLIND SPOT", () => {
    const md = hoverAuditSections(rows).join("\n");
    expect(md).toContain("**none — no-op**");
    expect(md).toContain("**BLIND SPOT**");
    expect(md).toContain("hover target not on this route");
  });

  it("escapes a pipe in element text so one finding cannot break the table", () => {
    const md = hoverAuditSections([
      { ...rows[0], revealed: [{ el: "span#x", text: "a | b" }] },
    ]).join("\n");
    expect(md).toContain("a \\| b");
  });

  it("emits nothing at all when no hover entry ran", () => {
    expect(hoverAuditSections([])).toEqual([]);
  });
});
