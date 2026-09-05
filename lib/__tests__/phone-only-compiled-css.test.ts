import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type AtRule, type Node, type Rule } from "postcss";
import { beforeAll, describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GLOBALS = path.join(REPO, "app/globals.css");
const TAILWIND_IMPORT = '@import "tailwindcss";';
const PHONE_MEDIA = new Set(["(width < 40rem)", "(max-width: 639.98px)"]);
// This is semantic identity only: no declaration counts, properties, or
// call-site census. It makes deleting or renaming a phone-only contract loud.
const PHONE_ONLY_CONTRACTS = [
  "band",
  "subpanel-inset",
  "subpanel-inset-sm",
  "subpanel-inset-xs",
  "section-seam",
  "section-seam-lg",
  "section-stack",
  "section-stack-sm",
  "table-cards",
  "table-section-row",
  "table-nested-row",
  "metric-readings-list",
  "logged-event-rows",
  "notification-kind-matrix",
] as const;

// The control box's own selector list, spelled once (#3938).
const CONTROL_BOX_SELECTOR =
  ".chip-base, .btn, .btn-ghost, .btn-danger, .button-control, .input, [data-segmented-option]";
const RANKING_UTILITIES = [
  "band",
  "bleed-none",
  "card",
  "card-quiet",
  "card-delegated",
  "card-gutter-standard",
  "card-gutter-compact",
  "card-gutter-action",
  // #3899: the band's gutter is only as good as the opt-out that outranks it, so
  // the delegating band's own token is compiled here beside the rules it beats.
  "px-0!",
] as const;

function normalized(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function contributesOnlyBelowSm(atRule: AtRule) {
  const params = normalized(atRule.params);
  if (atRule.name === "media") return PHONE_MEDIA.has(params);
  if (atRule.name === "variant") return params === "max-sm";
  return atRule.name === "apply" && /(?:^|[\s:])max-sm:/.test(params);
}

function discoverPhoneOnlyUtilities(source: string) {
  const names: string[] = [];
  postcss.parse(source, { from: GLOBALS }).walkAtRules("utility", (utility) => {
    let contributes = false;
    utility.walkAtRules((atRule) => {
      if (contributesOnlyBelowSm(atRule)) contributes = true;
    });
    if (!contributes) return;

    const name = normalized(utility.params);
    if (!/^[a-z][a-z0-9-]*$/.test(name))
      throw new Error(`phone-only utility has an unsupported name: ${name}`);
    names.push(name);
  });
  if (!names.length) throw new Error("no phone-only utilities were discovered");
  return names;
}

function contractNames(source: string) {
  const discovered = discoverPhoneOnlyUtilities(source).toSorted();
  const expected = [...PHONE_ONLY_CONTRACTS].toSorted();
  if (JSON.stringify(discovered) !== JSON.stringify(expected))
    throw new Error(
      `phone-only utility identities changed: expected ${expected.join(", ")}; discovered ${discovered.join(", ")}`
    );
  return discovered;
}

async function compile(source: string, names: readonly string[]) {
  const tailwindImports: AtRule[] = [];
  postcss.parse(source, { from: GLOBALS }).walkAtRules("import", (atRule) => {
    if (/^["']tailwindcss["'](?:\s|$)/.test(normalized(atRule.params)))
      tailwindImports.push(atRule);
  });
  if (
    tailwindImports.length !== 1 ||
    normalized(tailwindImports[0].params) !== '"tailwindcss"'
  )
    throw new Error(
      `expected exactly one plain ${TAILWIND_IMPORT} in app/globals.css`
    );
  const fixture = source.replace(
    TAILWIND_IMPORT,
    `@import "tailwindcss" source(none);\n@source inline(${JSON.stringify(names.join(" "))});`
  );
  return (
    await postcss([tailwindcss({ base: REPO })]).process(fixture, {
      from: GLOBALS,
    })
  ).css;
}

function isBelowSm(rule: Rule) {
  let node: Node = rule;
  while (node.parent) {
    const parent: Node = node.parent;
    if (parent.type === "atrule") {
      const atRule = parent as AtRule;
      if (atRule.name === "media" && PHONE_MEDIA.has(normalized(atRule.params)))
        return true;
    }
    node = parent;
  }
  return false;
}

function exactUtilitySelector(name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])\\.${escaped}(?![\\w-])`);
}

function assertPhoneOnly(css: string, names: readonly string[]) {
  const root = postcss.parse(css);
  const verified: string[] = [];
  for (const name of names) {
    const selector = exactUtilitySelector(name);
    const declarations: { rule: Rule; property: string }[] = [];
    root.walkRules((rule) => {
      if (!selector.test(rule.selector)) return;
      for (const child of rule.nodes ?? []) {
        if (child.type === "decl")
          declarations.push({ rule, property: child.prop });
      }
    });
    if (!declarations.length)
      throw new Error(`${name} did not emit any declarations`);

    const leaks = declarations.filter(({ rule }) => !isBelowSm(rule));
    if (leaks.length)
      throw new Error(
        `${name} emitted declarations at sm or above: ${leaks
          .map(({ rule, property }) => `${rule.selector} { ${property} }`)
          .join(", ")}`
      );
    verified.push(name);
  }
  return verified;
}

// The `@layer` a declaration lands in (null when unlayered) and whether it is
// important — the two facts that decide every contest in the phone block.
function declarationRanking(
  css: string,
  selector: string,
  property: string,
  belowSm: boolean
) {
  const found: { layer: string | null; important: boolean }[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (normalized(rule.selector) !== selector) return;
    if (isBelowSm(rule) !== belowSm) return;
    let layer: string | null = null;
    for (let node: Node = rule; node.parent; node = node.parent) {
      const parent = node.parent as Node;
      if (parent.type === "atrule" && (parent as AtRule).name === "layer")
        layer = normalized((parent as AtRule).params) || null;
    }
    for (const child of rule.nodes ?? [])
      if (child.type === "decl" && child.prop === property)
        found.push({ layer, important: child.important === true });
  });
  return found;
}

describe("compiled phone-only CSS proof (#3518/#3727)", () => {
  const source = fs.readFileSync(GLOBALS, "utf8");
  const names = contractNames(source);
  let compiledPhoneOnly: string;
  let compiledRanking: string;

  beforeAll(async () => {
    [compiledPhoneOnly, compiledRanking] = await Promise.all([
      compile(source, names),
      compile(source, RANKING_UTILITIES),
    ]);
  });

  it("keeps every discovered utility strictly below sm in a real Tailwind compile", () => {
    expect(assertPhoneOnly(compiledPhoneOnly, names)).toEqual(names);
  });

  it("rejects a planted desktop declaration", async () => {
    const leaked = source.replace(
      "@utility subpanel-inset {",
      "@utility subpanel-inset {\n  outline-color: red;"
    );
    expect(leaked).not.toBe(source);
    const compiledLeak = await compile(leaked, ["subpanel-inset"]);
    expect(() => assertPhoneOnly(compiledLeak, ["subpanel-inset"])).toThrow(
      "subpanel-inset emitted declarations at sm or above"
    );
  });

  it("rejects a missing or renamed utility", () => {
    const renamed = source.replace(
      "@utility subpanel-inset-xs {",
      "@utility subpanel-inset-xs-descendant {"
    );
    expect(renamed).not.toBe(source);
    expect(() => contractNames(renamed)).toThrow(
      "phone-only utility identities changed"
    );
  });

  it("rejects a widened Tailwind breakpoint while discovery still retains the utility", async () => {
    const root = postcss.parse(source, { from: GLOBALS });
    let mutation: AtRule | undefined;
    root.walkAtRules("utility", (utility) => {
      if (normalized(utility.params) !== "table-cards") return;
      utility.walkAtRules("apply", (atRule) => {
        if (!mutation && normalized(atRule.params) === "max-sm:block")
          mutation = atRule;
      });
    });
    expect(mutation, "the table-cards max-sm probe must exist").toBeDefined();
    mutation!.params = "max-md:block";
    const widened = root.toString();
    expect(contractNames(widened)).toEqual(names);

    const compiledLeak = await compile(widened, ["table-cards"]);
    expect(() => assertPhoneOnly(compiledLeak, ["table-cards"])).toThrow(
      "table-cards emitted declarations at sm or above"
    );
  });

  it("rejects a widened raw phone media query while discovery still retains the utility", async () => {
    const root = postcss.parse(source, { from: GLOBALS });
    let mutation: AtRule | undefined;
    root.walkAtRules("utility", (utility) => {
      if (normalized(utility.params) !== "metric-readings-list") return;
      utility.walkAtRules("media", (atRule) => {
        if (!mutation && normalized(atRule.params) === "(max-width: 639.98px)")
          mutation = atRule;
      });
    });
    expect(
      mutation,
      "the metric-readings-list raw phone-media probe must exist"
    ).toBeDefined();
    mutation!.params = "(max-width: 767.98px)";
    const widened = root.toString();
    expect(contractNames(widened)).toEqual(names);

    const compiledLeak = await compile(widened, ["metric-readings-list"]);
    expect(() =>
      assertPhoneOnly(compiledLeak, ["metric-readings-list"])
    ).toThrow("metric-readings-list emitted declarations at sm or above");
  });

  it("rejects a second Tailwind import that could restore automatic source scanning", async () => {
    await expect(
      compile(`${source}\n${TAILWIND_IMPORT}`, ["subpanel-inset"])
    ).rejects.toThrow("expected exactly one plain");
  });

  // WHICH DECLARATION WINS, READ OFF A COMPILE RATHER THAN REASONED ABOUT (#3920).
  // `@utility` bodies land in Tailwind's `utilities` layer. For NORMAL declarations
  // an unlayered one beats every layer; for IMPORTANT ones the order REVERSES and
  // unlayered ranks last. The full-bleed rules depend on both halves at once — the
  // band's pull has to beat a call site's own `rounded-xl border` in the same layer,
  // the card's has to beat that card's layered `p-4` and `max-w-full`, and neither
  // can beat `card-delegated`'s `p-0!`, which is exactly why the delegated cells
  // spend the page gutter themselves. Three regressions in this file have come from
  // getting that ranking wrong on paper, so it is a table of real compiled output.
  it.each([
    // selector, property, below `sm`, layer, important
    [".band", "margin-inline", true, "utilities", true],
    [".band", "border-radius", true, "utilities", true],
    [".band .band", "margin-inline", true, "utilities", true],
    // #3899: the band's gutter takes the CARD's ranking, not the band's own.
    // Unlayered and normal, so a call site's `p-6` in `utilities` loses to it and
    // a band that delegates its gutter to its rows still wins with `px-0!` —
    // important in `utilities`, which for important declarations outranks
    // unlayered. Both halves are one row each, read off a real compile.
    [".band", "padding-inline", true, null, false],
    [".px-0\\!", "padding-inline", false, "utilities", true],
    [".card, .card-quiet", "margin-inline", true, null, false],
    [".card, .card-quiet", "padding-inline", true, null, false],
    [".card, .card-quiet", "max-width", true, null, false],
    [".card", "padding", false, "utilities", false],
    [".card", "max-width", false, "utilities", false],
    [".card-delegated", "padding", false, "utilities", true],
    // #3931: the opt-out is a plain token on the container. It never competes with
    // the `:root` default — a declaration on the element beats an inherited value
    // whatever the layer — so it needs no `!important` and gets none.
    [".bleed-none", "--page-bleed-left", false, "utilities", false],
    [
      ".card-gutter-standard, .card-gutter-compact, .card-gutter-action",
      "padding-inline",
      true,
      null,
      false,
    ],
    // #3938: the control box is TWO declarations in two different places, and
    // which place each one sits in is the whole design. The derived padding is
    // UNLAYERED so it outranks a call site's own `py-*` in `utilities` — that is
    // what makes 34 the box rather than a default. The floor for icon-only
    // content is in `components` so it LOSES to a call site asking for more,
    // because `min-block-size` replaces rather than composes and the
    // `min-h-16`/`min-h-20` textareas must keep their height. Neither is
    // `!important`: for important declarations the layer order reverses and
    // unlayered would rank LAST, which is how #3896 pinned 18 consumers at the
    // phone floor on desktop.
    [CONTROL_BOX_SELECTOR, "padding-block", false, null, false],
    [CONTROL_BOX_SELECTOR, "border-width", false, null, false],
    [CONTROL_BOX_SELECTOR, "min-block-size", false, "components", false],
    // #3954: a checkbox label has no line box, so it takes the floor on BOTH
    // axes instead of the derived padding — in `components` with the rest of the
    // floor, and un-important, because a phone floor spelled with `!` is exactly
    // what #3896 had to undo.
    [".checkbox-control", "min-block-size", false, "components", false],
    [".checkbox-control", "min-inline-size", false, "components", false],
  ] as const)(
    "%s { %s } below-sm=%s compiles into layer %s important=%s",
    (selector, property, belowSm, layer, important) => {
      const found = declarationRanking(
        compiledRanking,
        selector,
        property,
        belowSm
      );
      expect(found).toEqual([{ layer, important }]);
    }
  );

  // A CONTROL BOX THAT LOST ITS RANK STILL COMPILES, AND STILL READS RIGHT (#3938).
  // The failure this catches is the quiet one: wrap the box in a layer and every
  // declaration is still there, still 34, still on the right selectors — it simply
  // stops beating the `py-1` a call site already carries, and the height it prints
  // depends on which call site you look at.
  it("rejects a control box demoted into a layer, where a call site's own padding beats it", async () => {
    const demoted = source.replace(
      `${CONTROL_BOX_SELECTOR.split(", ").join(",\n")} {\n  border-width:`,
      `@layer components {\n${CONTROL_BOX_SELECTOR.split(", ").join(",\n")} {\n  border-width:`
    );
    expect(demoted, "the control box rule must be found to mutate").not.toBe(
      source
    );
    const compiledDemotion = await compile(
      `${demoted}\n}`,
      ["card"] // any real utility; the box's rules are plain CSS and always emit
    );
    expect(
      declarationRanking(
        compiledDemotion,
        CONTROL_BOX_SELECTOR,
        "padding-block",
        false
      )
    ).toEqual([{ layer: "components", important: false }]);
  });

  it("matches exact class tokens, including nested rules, not lookalikes", () => {
    const selector = exactUtilitySelector("subpanel-inset-xs");
    expect(selector.test(".subpanel-inset-xs:hover")).toBe(true);
    expect(selector.test(".host > .subpanel-inset-xs[data-open]")).toBe(true);
    expect(selector.test(".subpanel-inset-xs .descendant")).toBe(true);
    expect(selector.test(".subpanel-inset-xs-descendant")).toBe(false);
    expect(selector.test(".host-subpanel-inset-xs")).toBe(false);
  });
});
