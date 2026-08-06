import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the row-action convention (issue #1491 guard 12c, making
// #1488's standard structural).
//
// The app's ONE per-row edit/delete affordance is the ⋯ overflow menu
// (components/OverflowMenu.tsx) — RecordTable ships it for every Records page,
// and the entry-history tables render it directly. The drift the audit found
// was hand-cloned inline pencil+trash button pairs: three copies outside
// RecordTable's shell, each with its own hover styling and no confirm/menu
// semantics, invisible to any later menu-wide change.
//
// The signature of that clone is a file importing BOTH IconPencil and
// IconTrash from @tabler/icons-react — a per-row pair. A file that uses one of
// them alone (an edit-mode toggle, a bulk-delete button) passes; a file that
// legitimately needs both for something that is NOT a row-action pair declares
// itself below with the reason.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// Files allowed to import both icons, each with the reason the pair is not a
// hand-rolled row-action clone.
const ALLOWLIST = new Map<string, string>([
  [
    "components/DataTableManager.tsx",
    "IconPencil is the table-wide edit-MODE toggle and IconTrash labels the " +
      "bulk 'Delete selected/all' buttons — table-level controls, not a " +
      "per-row action pair",
  ],
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

function importsBoth(text: string): boolean {
  return /\bIconPencil\b/.test(text) && /\bIconTrash\b/.test(text);
}

describe("row-action convention (⋯ overflow menu) — issue #1491 guard 12c", () => {
  it("no file hand-rolls an inline pencil+trash row-action pair", () => {
    const offenders: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      if (ALLOWLIST.has(rel)) continue;
      if (importsBoth(text)) offenders.push(rel);
    }
    expect(
      offenders,
      `These files import both IconPencil and IconTrash — the signature of a ` +
        `hand-rolled inline edit/delete row-action pair. Per-row edit/delete ` +
        `belongs in the shared ⋯ OverflowMenu (see RecordTable, or render ` +
        `components/OverflowMenu directly). If the pair is genuinely not a ` +
        `row-action clone, add an ALLOWLIST entry with the reason:\n` +
        offenders.join("\n")
    ).toEqual([]);
  });

  it("every allowlist entry still names a file importing both icons (no stale exemptions)", () => {
    for (const [rel, reason] of ALLOWLIST) {
      const abs = path.join(REPO, rel);
      expect(
        fs.existsSync(abs),
        `${rel} allowlisted (${reason}) but missing`
      ).toBe(true);
      expect(
        importsBoth(fs.readFileSync(abs, "utf8")),
        `${rel} no longer imports both icons — remove its allowlist entry`
      ).toBe(true);
    }
  });
});
