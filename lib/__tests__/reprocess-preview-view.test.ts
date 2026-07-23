import { describe, it, expect } from "vitest";
import { reprocessPreviewView } from "@/lib/reprocess-preview-view";

// #1071: a reprocess preview that produces no changes must disable the commit and
// read as a no-change headline; a diff-producing preview keeps the commit enabled.
describe("reprocessPreviewView", () => {
  it("disables the commit when a fresh re-extraction changes nothing", () => {
    const view = reprocessPreviewView({ hasChanges: false });
    expect(view.noChange).toBe(true);
    expect(view.commitDisabled).toBe(true);
  });

  it("keeps the commit enabled when the diff has changes", () => {
    const view = reprocessPreviewView({ hasChanges: true });
    expect(view.noChange).toBe(false);
    expect(view.commitDisabled).toBe(false);
  });
});
