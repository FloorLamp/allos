import { describe, it, expect } from "vitest";
import {
  medBoardOrder,
  medBoardAnchor,
  medBoardId,
  medStripMember,
  medStripMemberHasItems,
} from "@/lib/medication-multi-view";
import { MEDICATIONS_HREF, nutritionTabHref } from "@/lib/hrefs";
import type { UpcomingItem } from "@/lib/upcoming";

function item(
  over: Partial<UpcomingItem> & Pick<UpcomingItem, "key">
): UpcomingItem {
  return {
    domain: "dose",
    title: "Med",
    href: MEDICATIONS_HREF,
    dueDate: null,
    ...over,
  } as UpcomingItem;
}

describe("medBoardOrder (#1373) — acting first, then view order", () => {
  it("puts the acting profile first, preserving the rest in view order", () => {
    expect(medBoardOrder(7, [3, 7, 9])).toEqual([7, 3, 9]);
  });

  it("is a no-op ordering when acting already leads", () => {
    expect(medBoardOrder(7, [7, 3, 9])).toEqual([7, 3, 9]);
  });

  it("single-view is just the acting profile", () => {
    expect(medBoardOrder(7, [7])).toEqual([7]);
  });

  it("falls back to the raw view when acting is somehow not in view", () => {
    expect(medBoardOrder(7, [3, 9])).toEqual([3, 9]);
  });
});

describe("medBoard anchors", () => {
  it("id and anchor agree", () => {
    expect(medBoardAnchor(42)).toBe(`#${medBoardId(42)}`);
    expect(medBoardId(42)).toBe("med-board-42");
  });
});

describe("medStripMember (#1373 point 6) — medication-only, from the household rollup", () => {
  it("keeps only medication dose/refill rows (drops supplements)", () => {
    const strip = medStripMember(5, {
      dueDoses: [
        item({ key: "dose:1", title: "Amoxicillin", href: MEDICATIONS_HREF }),
        item({
          key: "dose:2",
          title: "Vitamin D",
          href: nutritionTabHref("supplements"),
        }),
      ],
      lowRefills: [
        item({
          key: "refill:3",
          domain: "refill",
          title: "Lisinopril",
          href: MEDICATIONS_HREF,
          detail: "~4 days left",
        }),
        item({
          key: "refill:4",
          domain: "refill",
          title: "Fish oil",
          href: nutritionTabHref("supplements"),
        }),
      ],
    });
    expect(strip.profileId).toBe(5);
    expect(strip.dueDoses.map((d) => d.title)).toEqual(["Amoxicillin"]);
    expect(strip.lowRefills.map((r) => r.title)).toEqual(["Lisinopril"]);
    expect(strip.lowRefills[0].detail).toBe("~4 days left");
  });

  it("carries the dose-bucket dueText through for the chip tooltip", () => {
    const strip = medStripMember(5, {
      dueDoses: [
        item({ key: "dose:1", title: "Amoxicillin", dueText: "Morning" }),
      ],
      lowRefills: [],
    });
    expect(strip.dueDoses[0].dueText).toBe("Morning");
  });

  // THE STRIP'S WHOLE CAPABILITY RIDES ON THIS FIELD (#4429): the row offers the
  // tri-state only where `item.doseId != null`, so a mapper that dropped the id would
  // retire the control everywhere and change nothing else on screen. Asked THROUGH
  // `medStripMember`, because a hand-built `MedStripItem` sets the field itself and
  // could not see the mapper lose it.
  it("carries the scheduled dose id through, which is what lets a row host the control", () => {
    const strip = medStripMember(5, {
      dueDoses: [item({ key: "dose:1", title: "Amoxicillin", doseId: 91 })],
      lowRefills: [],
    });
    expect(strip.dueDoses[0].doseId).toBe(91);
  });

  it("medStripMemberHasItems is false only when a member is fully quiet", () => {
    const quiet = medStripMember(5, { dueDoses: [], lowRefills: [] });
    expect(medStripMemberHasItems(quiet)).toBe(false);
    const busy = medStripMember(5, {
      dueDoses: [item({ key: "dose:1", title: "Amoxicillin" })],
      lowRefills: [],
    });
    expect(medStripMemberHasItems(busy)).toBe(true);
  });

  it("a member with only supplement rows contributes nothing (dropped)", () => {
    const strip = medStripMember(5, {
      dueDoses: [
        item({
          key: "dose:2",
          title: "Vitamin D",
          href: nutritionTabHref("supplements"),
        }),
      ],
      lowRefills: [],
    });
    expect(medStripMemberHasItems(strip)).toBe(false);
  });
});
