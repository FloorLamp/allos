import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const source = fs.readFileSync(
  path.join(REPO, "app/(app)/timeline/page.tsx"),
  "utf8"
);

describe("Timeline card surface", () => {
  it("uses the quiet Botanical surface instead of the legacy elevated colors", () => {
    const cardClass = source.match(
      /const CARD_CLASS =\s*\n?\s*"([^"]+)";/
    )?.[1];

    expect(cardClass).toContain("border-(--border)");
    expect(cardClass).toContain("bg-surface");
    expect(cardClass).not.toContain("bg-white");
    expect(cardClass).not.toContain("dark:bg-ink-900");
  });

  it("keeps repeated cards flat and uses the semantic hover fill", () => {
    expect(source).not.toMatch(/rounded-lg border px-4 py-3 shadow-xs/);
    expect(source).toContain("hover:bg-(--ghost-hover)");
  });
});
