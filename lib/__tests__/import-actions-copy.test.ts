import { describe, it, expect } from "vitest";
import { importActionExplainers } from "@/lib/import-actions-copy";

// The per-control explainer matrix for the import-detail Actions section (#1340):
// deterministic-vs-AI × has-raw. The whole point of a small copy model is that this
// matrix can't drift from what the buttons actually render.

describe("importActionExplainers", () => {
  it("deterministic imports: preview is FREE and EXACT, and NO re-apply narration", () => {
    for (const hasRaw of [true, false]) {
      const e = importActionExplainers({ deterministic: true, hasRaw });
      expect(e.preview).toMatch(/free/i);
      expect(e.preview).toMatch(/exact/);
      // Product-decided: deterministic docs get zero re-apply narration anywhere.
      expect(e.reapply).toBeNull();
    }
  });

  // THE GUARD FOR #3493 ITEM 4, and it is an ABSENCE assertion on purpose.
  //
  // The defect was internals-speak, so no positive assertion can close the class: any
  // wording that says what the button does for the reader would satisfy one, and the
  // next person restoring "no AI call, no quota" would satisfy it too. What must not
  // come back is our own accounting, on the branch where the reader pays nothing.
  //
  // Scoped to the DETERMINISTIC branch, which is the whole of #3493's finding. The AI
  // branch's "costs one daily extraction" is a real price and is asserted below,
  // unchanged — a sweep over both would delete the one cost warning #1340 exists to
  // keep.
  it("deterministic preview mentions neither AI calls nor quota (#3493)", () => {
    for (const hasRaw of [true, false]) {
      const e = importActionExplainers({ deterministic: true, hasRaw });
      expect(e.preview).not.toMatch(/quota/i);
      expect(e.preview).not.toMatch(/\bAI\b/);
    }
  });

  it("AI documents carry the daily-extraction cost note on preview, with OR without raw", () => {
    for (const hasRaw of [true, false]) {
      const e = importActionExplainers({ deterministic: false, hasRaw });
      expect(e.preview).toMatch(/costs one daily extraction/);
    }
  });

  it("AI + hasRaw: re-apply explainer describes the no-AI replay", () => {
    const e = importActionExplainers({ deterministic: false, hasRaw: true });
    expect(e.reapply).not.toBeNull();
    expect(e.reapply).toMatch(/no AI call, no quota/);
  });

  it("AI without raw: no re-apply narration (the button isn't rendered)", () => {
    const e = importActionExplainers({ deterministic: false, hasRaw: false });
    expect(e.reapply).toBeNull();
  });

  it("delete explainer is stable across the matrix", () => {
    const cells = [
      { deterministic: true, hasRaw: true },
      { deterministic: true, hasRaw: false },
      { deterministic: false, hasRaw: true },
      { deterministic: false, hasRaw: false },
    ];
    for (const c of cells) {
      expect(importActionExplainers(c).delete).toMatch(/can’t be undone/);
    }
  });
});
