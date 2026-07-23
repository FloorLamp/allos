import type { ImportDiff } from "@/lib/import-diff";

// The commit affordance for a reprocess PREVIEW's diff (#1071). When a fresh
// re-extraction would change nothing, the preview says so as the HEADLINE (a plain
// statement + the unchanged count) and the "Save changes" button is DISABLED — a
// user must never be able to commit a pointless full row-replacement of identical
// content. This is the "we ran it and it changed nothing" case; it is distinct
// from the content-hash "skipped" short-circuit ("we didn't run it"), which keeps
// its "Re-extract anyway" override. Pure so the decision is unit-tested without a
// live extractor (the ok/no-change branch isn't reachable in the extractor-less
// e2e env — see import-records-browser.spec.ts).
export function reprocessPreviewView(diff: Pick<ImportDiff, "hasChanges">): {
  // The re-extraction produced identical results.
  noChange: boolean;
  // Disable the commit/"Save changes" button (nothing to save).
  commitDisabled: boolean;
} {
  const noChange = !diff.hasChanges;
  return { noChange, commitDisabled: noChange };
}
