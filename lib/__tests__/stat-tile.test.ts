import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

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
    const body = utilityBody(css, "stat-tile");
    expect(body).toContain("var(--ghost)");
    expect(body).toContain("var(--radius-card)");
    expect(body).not.toMatch(/bg-slate-|bg-ink-|rounded-lg/);

    const component = fs.readFileSync(
      path.join(ROOT, "components/StatBox.tsx"),
      "utf8"
    );
    expect(component).toContain(': "stat-tile"');
  });
});
