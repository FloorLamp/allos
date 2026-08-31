import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss, {
  type AtRule,
  type Declaration,
  type Result,
  type Rule,
} from "postcss";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GLOBALS = path.join(REPO, "app/globals.css");
const TAILWIND_IMPORT = '@import "tailwindcss";';

const PROBES = [
  ["sm", "1901px", "40rem"],
  ["md", "1902px", "48rem"],
  ["lg", "1903px", "64rem"],
  ["xl", "1904px", "80rem"],
  ["2xl", "1905px", "96rem"],
  ["3xl", "1906px", "120rem"],
] as const;
const CARD_UTILITIES = [
  "card-delegated",
  "card-gutter-standard",
  "card-gutter-compact",
  "card-gutter-action",
] as const;

let compiled: Promise<Result> | undefined;

function compiledCss(): Promise<Result> {
  if (compiled) return compiled;
  const globals = fs.readFileSync(GLOBALS, "utf8");
  const candidates = PROBES.map(
    ([variant, value]) => `${variant}:max-w-[${value}]`
  )
    .concat(CARD_UTILITIES)
    .join(" ");
  // These are the complete subjects of this compile. Letting Tailwind discover the
  // repository first added no coverage and made this tiny contract contend on every
  // source file with the rest of the suite.
  const fixture = globals.replace(
    TAILWIND_IMPORT,
    `@import "tailwindcss" source(none);\n@source inline(${JSON.stringify(candidates)});`
  );
  if (fixture === globals) throw new Error("Tailwind import not found");
  compiled = Promise.resolve(
    postcss([tailwindcss({ base: REPO })]).process(fixture, { from: GLOBALS })
  );
  return compiled;
}

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

describe("named breakpoint order (#3477)", () => {
  it("keeps custom named breakpoints in the same rem unit family", () => {
    const css = fs.readFileSync(GLOBALS, "utf8");
    const declarations = [
      ...css.matchAll(/--breakpoint-([\w-]+):\s*([^;]+);/g),
    ].map((match) => ({ name: match[1], value: match[2].trim() }));

    expect(
      declarations.length,
      "no custom named breakpoint was found"
    ).toBeGreaterThan(0);
    expect(
      declarations.filter(({ value }) => !/^\d+(?:\.\d+)?rem$/.test(value)),
      "Tailwind cannot sort px-valued custom named breakpoints against its rem-valued defaults"
    ).toEqual([]);
  });

  it("emits 3xl after the default rem-valued named breakpoints in a real Tailwind compile", async () => {
    const result = await compiledCss();
    const emitted: { value: string; media: string }[] = [];
    result.root.walkDecls("max-width", (declaration) => {
      const probe = PROBES.find(([, value]) => value === declaration.value);
      if (!probe) return;
      const media = declaration.parent?.parent;
      if (media?.type !== "atrule" || media.name !== "media") {
        throw new Error(
          `${probe[0]} probe did not compile inside a media query`
        );
      }
      emitted.push({ value: probe[1], media: (media as AtRule).params });
    });

    expect(emitted).toEqual(
      PROBES.map(([, value, width]) => ({
        value,
        media: `(width >= ${width})`,
      }))
    );
  });
});

// These compiled contracts deliberately share one Tailwind pass. Compiling the
// same globals independently was most of both files' runtime and proved no extra
// behavior; the inline breakpoint probes do not alter the authored card rules.
describe("DelegatedCard compiled gutters", () => {
  it("compiles the root premise and the three closed horizontal roles", async () => {
    const result = await compiledCss();
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
