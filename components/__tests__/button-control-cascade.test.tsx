import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type Node, type Rule } from "postcss";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import Button from "@/components/Button";

// THE CONTROL BOX'S CASCADE (#3518 proof tier, #3896, #3938). `button-control` used
// to render 44 on a phone and shed it from `sm` up, and one adopter's `!important`
// min-size beat that reset at every width — which pinned eighteen consumers at the
// phone floor on the desktop. The box retired the step: one height, both viewports,
// and the floor that carries an icon-only composition declared once and
// unconditionally. Rendered geometry proves the sizes; this proves the cascade, over
// the classes read off a RENDERED bearer so the list cannot drift from the primitive.
// (It lived beside the retired disclosure primitive until #4760; the claim is about
// the box, so it moved with the box's own bearer.)

// jsdom gives `import.meta.url` an http origin, so the repo is anchored on the
// vitest root instead — the same directory every project in vitest.config.ts runs from.
const REPO = process.cwd();
const GLOBALS = path.join(REPO, "app/globals.css");

/** Compile app/globals.css for exactly these classes (the technique
 *  lib/__tests__/phone-only-compiled-css.test.ts uses). */
async function compileFor(classes: readonly string[]) {
  const source = fs.readFileSync(GLOBALS, "utf8");
  const fixture = source.replace(
    '@import "tailwindcss";',
    `@import "tailwindcss" source(none);\n@source inline(${JSON.stringify(classes.join(" "))});`
  );
  return (
    await postcss([tailwindcss({ base: REPO })]).process(fixture, {
      from: GLOBALS,
    })
  ).css;
}

/** The nearest enclosing selector. Tailwind NESTS a utility's media rules inside the
 *  rule, so a declaration's own parent there is the `@media`, not the rule. */
function owningSelector(node: Node): string {
  let current = node.parent as Node | undefined;
  while (current) {
    if (current.type === "rule") return (current as Rule).selector;
    current = current.parent as Node | undefined;
  }
  return "";
}

function minSizeDeclarations(css: string) {
  const found: { selector: string; property: string; important: boolean }[] =
    [];
  postcss.parse(css).walkDecls((declaration) => {
    if (!/^min-(height|width|block-size|inline-size)$/.test(declaration.prop))
      return;
    found.push({
      selector: owningSelector(declaration),
      property: declaration.prop,
      important: declaration.important,
    });
  });
  return found;
}

function bearerClasses() {
  const { unmount } = render(<Button>Save</Button>);
  const classes = screen
    .getByRole("button", { name: "Save" })
    .className.split(/\s+/);
  unmount();
  return classes;
}

describe("button-control compiled CSS", () => {
  let compiled = "";
  let planted = "";

  beforeAll(async () => {
    const classes = bearerClasses();
    expect(classes).toContain("button-control");
    compiled = await compileFor(classes);
    planted = await compileFor([...classes, "min-h-11!", "min-w-11!"]);
  });

  it("emits no !important min-size on the bearer", () => {
    expect(
      minSizeDeclarations(compiled).filter(
        (declaration) => declaration.important
      )
    ).toEqual([]);
  });

  it("takes no viewport step: one box at every width", () => {
    const root = postcss.parse(compiled);
    const stepped: string[] = [];
    root.walkAtRules("media", (atRule) => {
      if (!/\bwidth\b/.test(atRule.params)) return;
      atRule.walkDecls(/^min-(block|inline)-size$/, (declaration) => {
        if (/\.button-control(?![\w-])/.test(owningSelector(declaration)))
          stepped.push(
            `${atRule.params.replace(/\s+/g, " ").trim()} { ${declaration.prop}: ${declaration.value} }`
          );
      });
    });
    expect(
      stepped,
      "`button-control` may not change size with the viewport; it wears the one control box"
    ).toEqual([]);
    // …and the converse, so the empty list above is not empty because the
    // selector vanished: the box's own floor is there, unconditionally.
    expect(
      minSizeDeclarations(compiled).filter(
        (declaration) =>
          /\.button-control(?![\w-])/.test(declaration.selector) &&
          declaration.property === "min-block-size"
      ).length,
      "the control box's floor must reach `.button-control`"
    ).toBeGreaterThan(0);
  });

  it("sees the markers if they are put back", () => {
    expect(
      minSizeDeclarations(planted)
        .filter((declaration) => declaration.important)
        .map((declaration) => declaration.property)
        .toSorted()
    ).toEqual(["min-height", "min-width"]);
  });
});
