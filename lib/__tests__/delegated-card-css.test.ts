import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type AtRule, type Declaration, type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GLOBALS = path.join(REPO, "app/globals.css");

function declaration(rule: Rule, property: string): Declaration {
  const found = rule.nodes.find(
    (node): node is Declaration =>
      node.type === "decl" && node.prop === property
  );
  if (!found) throw new Error(`${rule.selector} has no ${property}`);
  return found;
}

function responsiveDeclaration(rule: Rule): Declaration {
  const media = rule.nodes.find(
    (node): node is AtRule => node.type === "atrule" && node.name === "media"
  );
  expect(media?.params).toBe("(width >= 40rem)");
  const found = media?.nodes?.find(
    (node): node is Declaration =>
      node.type === "decl" && node.prop === "padding-inline"
  );
  if (!found) throw new Error(`${rule.selector} has no responsive gutter`);
  return found;
}

// NO CEILING ON THIS DESCRIBE ANY MORE (#4002). It carried `{ timeout: 120_000 }`,
// which `ALLOS_VITEST_TIMEOUT_MS` cannot reach. Its one test compiles globals.css
// through PostCSS + Tailwind and reads 1 801 ms on the green CI run at f1742fa6d
// (968 ms on the dispatch box under coverage), so the tier's 15 000 ms is ~8x.
describe("DelegatedCard compiled gutters", () => {
  it("compiles the root premise and the three closed horizontal roles", async () => {
    const css = fs.readFileSync(GLOBALS, "utf8");
    const result = await postcss([tailwindcss()]).process(css, {
      from: GLOBALS,
    });
    const rules = new Map<string, Rule[]>();
    result.root.walkRules((rule) => {
      if (
        [
          ".card-delegated",
          ".card-gutter-standard",
          ".card-gutter-compact",
          ".card-gutter-action",
        ].includes(rule.selector)
      ) {
        rules.set(rule.selector, [...(rules.get(rule.selector) ?? []), rule]);
      }
    });

    expect([...rules.keys()].sort()).toEqual([
      ".card-delegated",
      ".card-gutter-action",
      ".card-gutter-compact",
      ".card-gutter-standard",
    ]);

    for (const selector of rules.keys()) {
      expect(
        rules.get(selector),
        `${selector} must compile exactly once`
      ).toHaveLength(1);
    }

    const root = rules.get(".card-delegated")![0];
    expect(declaration(root, "overflow").value).toBe("hidden");
    const zero = declaration(root, "padding");
    expect([zero.value, zero.important]).toEqual(["0px", true]);

    const expected = [
      [".card-gutter-standard", 4, 5],
      [".card-gutter-compact", 2, 5],
      [".card-gutter-action", 2, 3],
    ] as const;
    for (const [selector, phone, desktop] of expected) {
      const rule = rules.get(selector)![0];
      expect(declaration(rule, "padding-inline").value).toBe(
        `calc(var(--spacing) * ${phone})`
      );
      expect(responsiveDeclaration(rule).value).toBe(
        `calc(var(--spacing) * ${desktop})`
      );
    }
  });
});
