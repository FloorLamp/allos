import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERSONAS, personaFromEnv } from "../../scripts/seed-personas";
import { DYNAMIC_ROUTES } from "../../scripts/ux-census-routes.mjs";

// The persona-seed registry contracts (SEED_PERSONA, scripts/seed-personas.ts).
// Personas are a seeing-tool feature like the #2594 dials, but their selection
// rule is stricter: a census run records the persona it asked for, so a typo
// must FAIL the seed rather than fall back — these pins keep that selection
// honest, and keep each persona's census route targets pointing at pages that
// still exist (a renamed route would otherwise silently un-target a persona's
// whole reason to exist).

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, "..", "..", "app", "(app)");

function walk(dir: string, route: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) {
      if (e.name === "page.tsx") out.push(route || "/");
      continue;
    }
    walk(path.join(dir, e.name), `${route}/${e.name}`, out);
  }
}

const allRoutes: string[] = [];
walk(appDir, "", allRoutes);
const censusTargets = [
  ...allRoutes.filter((r) => !r.includes("[")),
  ...DYNAMIC_ROUTES.map((d) => d.pattern),
];

describe("persona registry", () => {
  it("has unique kebab-case names", () => {
    const names = PERSONAS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("gives every persona a title, description, and apply()", () => {
    for (const p of PERSONAS) {
      expect(p.title.length, p.name).toBeGreaterThan(0);
      expect(p.description.length, p.name).toBeGreaterThan(0);
      expect(typeof p.apply, p.name).toBe("function");
    }
  });

  it("targets only routes the census can visit", () => {
    // Each entry is a UX_ROUTES prefix filter; it must match at least one
    // enumerable route (static page.tsx or a registered dynamic pattern), or
    // the persona run would census nothing for it.
    for (const p of PERSONAS) {
      expect(p.routes.length, p.name).toBeGreaterThan(0);
      for (const r of p.routes) {
        expect(r.startsWith("/"), `${p.name}: ${r}`).toBe(true);
        const hit = censusTargets.some((t) => t === r || t.startsWith(r));
        expect(hit, `${p.name}: ${r} matches no censusable route`).toBe(true);
      }
    }
  });
});

describe("personaFromEnv", () => {
  it("returns none when unset or empty", () => {
    expect(personaFromEnv({}).kind).toBe("none");
    expect(personaFromEnv({ SEED_PERSONA: "" }).kind).toBe("none");
    expect(personaFromEnv({ SEED_PERSONA: "  " }).kind).toBe("none");
  });

  it("finds every registered persona by exact name", () => {
    for (const p of PERSONAS) {
      const sel = personaFromEnv({ SEED_PERSONA: p.name });
      expect(sel.kind).toBe("found");
      if (sel.kind === "found") expect(sel.persona.name).toBe(p.name);
    }
  });

  it("trims surrounding whitespace", () => {
    const sel = personaFromEnv({ SEED_PERSONA: " toddler " });
    expect(sel.kind).toBe("found");
  });

  it("reports unknown names with the known list, never a fallback", () => {
    const sel = personaFromEnv({ SEED_PERSONA: "bodybuildr" });
    expect(sel.kind).toBe("unknown");
    if (sel.kind === "unknown") {
      expect(sel.raw).toBe("bodybuildr");
      expect(sel.known).toEqual(PERSONAS.map((p) => p.name));
    }
  });
});
