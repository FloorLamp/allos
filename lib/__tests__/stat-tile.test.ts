import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";

const ROOT = path.resolve(import.meta.dirname, "../..");

function utilityBody(css: string, name: string): string {
  const start = css.indexOf(`@utility ${name} {`);
  if (start < 0) throw new Error(`Missing @utility ${name}`);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}" && --depth === 0) return css.slice(start, index + 1);
  }
  throw new Error(`Unclosed @utility ${name}`);
}

describe("StatBox", () => {
  it("keeps the stat tile on the surface token and radius", () => {
    const css = fs.readFileSync(path.join(ROOT, "app/globals.css"), "utf8");
    expect(css.match(/@utility stat-tile\s*\{/g)).toHaveLength(1);
    const body = utilityBody(css, "stat-tile");
    expect(body).toContain("var(--ghost)");
    expect(body).toContain("var(--radius-card)");
    expect(body).not.toMatch(/bg-slate-|bg-ink-|rounded-lg/);

    const component = fs.readFileSync(
      path.join(ROOT, "components/StatBox.tsx"),
      "utf8"
    );
    expect(component).toContain(': "stat-tile"');
    expect(stripComments(component)).not.toMatch(/bg-slate-50|bg-ink-900/);

    const cycles = fs.readFileSync(
      path.join(ROOT, "app/(app)/medical/cycles/page.tsx"),
      "utf8"
    );
    expect(cycles.match(/<StatBox/g)).toHaveLength(4);
    expect(cycles).not.toMatch(/stat-tile|bg-slate-50|bg-ink-900/);

    // #3775 folded the equipment detail grid in the same direction: its local
    // `Stat` drew a BORDERED `rounded-lg border bg-surface` tile, the third
    // treatment #3475 set out to end. The rendered converse — that the shared
    // box still draws label/value/sub — is components/__tests__/stat-box.test.tsx.
    const equipment = fs.readFileSync(
      path.join(ROOT, "app/(app)/equipment/[id]/page.tsx"),
      "utf8"
    );
    expect(equipment.match(/<StatBox/g)).toHaveLength(6);
    expect(stripComments(equipment)).not.toMatch(
      /function Stat\(|bg-surface px-4/
    );
  });
});
