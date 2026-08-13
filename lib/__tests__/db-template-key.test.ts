// The DB tier's template cache is only as honest as its key.
//
// `templateKey()` decides whether the migrated template on disk may be reused, so
// an input it does not hash is an input that can go stale silently. The migration
// sources are the obvious half and the seed dataset is the half that was missed:
// "boot tasks re-run per file, so their effects are reapplied" is true of an ADD
// and an UPDATE, and false of a DELETE. Nothing removes a `seed` row the dataset
// no longer has, so a reused template keeps serving it.
//
// Measured before this guard existed: dropping an entry from
// lib/canonical-biomarkers.json and re-running the tier still returned
// `{"name":"Audiologic Diagnosis","source":"seed"}` from the cached template,
// where the same experiment without the cache answered `null`.
//
// These cases assert the KEY, not the cache's behaviour — the key is the cheap,
// pure thing, and it is what decides everything downstream.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { templateKey } from "@/lib/__db_tests__/shared-template";

/** Run `fn` with `file` temporarily edited, always restoring the original. */
function withEdited(file: string, edit: (src: string) => string): string {
  const abs = path.join(process.cwd(), file);
  const original = fs.readFileSync(abs, "utf8");
  try {
    fs.writeFileSync(abs, edit(original));
    return templateKey();
  } finally {
    fs.writeFileSync(abs, original);
  }
}

describe("the DB template cache key", () => {
  it("is stable when nothing changes", () => {
    expect(templateKey()).toBe(templateKey());
  });

  it("changes when a migration changes", () => {
    // The half that was never in doubt, asserted so the walk itself cannot
    // silently stop reading the migrations directory.
    const before = templateKey();
    const after = withEdited(
      "lib/migrations/versions/index.ts",
      (s) => s + "\n// orchestrator probe\n"
    );
    expect(after).not.toBe(before);
  });

  it("changes when the seed dataset a boot task bakes changes", () => {
    // The half that was missed. A REMOVAL is the case that matters: an upsert
    // corrects a changed row on every boot, and nothing deletes a stale one.
    const before = templateKey();
    const after = withEdited("lib/canonical-biomarkers.json", (s) => {
      const parsed = JSON.parse(s) as { biomarkers: { name: string }[] };
      parsed.biomarkers.pop();
      return JSON.stringify(parsed, null, 2) + "\n";
    });
    expect(
      after,
      "dropping a canonical biomarker must invalidate the template, or the " +
        "cached one keeps serving a seed row the dataset no longer has"
    ).not.toBe(before);
  });

  it("restores every file it edits", () => {
    // The cases above write to tracked files. If one ever failed to restore, the
    // damage would be a corrupted dataset in someone's working tree, so the
    // restoration is asserted rather than trusted to a finally block nobody reads.
    expect(templateKey()).toBe(templateKey());
    const parsed = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "lib/canonical-biomarkers.json"),
        "utf8"
      )
    ) as { biomarkers: unknown[] };
    expect(parsed.biomarkers.length).toBeGreaterThan(100);
  });
});
