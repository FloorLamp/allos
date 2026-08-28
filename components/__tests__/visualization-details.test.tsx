import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type Node, type Rule } from "postcss";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import VisualizationDetails from "@/components/VisualizationDetails";

// jsdom gives `import.meta.url` an http origin, so the repo is anchored on the
// vitest root instead — the same directory every project in vitest.config.ts runs from.
const REPO = process.cwd();
const GLOBALS = path.join(REPO, "app/globals.css");
const SM = "(min-width: 40rem)";

/**
 * Compile app/globals.css for exactly the classes a rendered summary wears (#3518's
 * proof tier, the technique lib/__tests__/phone-only-compiled-css.test.ts uses). A
 * class list read off the RENDERED element cannot drift from the component the way a
 * hand-copied one can.
 */
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

/** The nearest enclosing selector. Tailwind NESTS `button-control`'s sm+ reset inside
 *  the rule, so a declaration's own parent there is the `@media`, not the rule. */
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

function summaryClasses() {
  const { unmount } = render(
    <VisualizationDetails label="Weekly details" items={["Aug 3–9 · met"]} />
  );
  const classes = screen.getByText("Weekly details").className.split(/\s+/);
  unmount();
  return classes;
}

describe("VisualizationDetails", () => {
  it("keeps every visual value behind one keyboard and touch disclosure", () => {
    render(
      <VisualizationDetails
        label="Weekly details"
        items={["Aug 3–9 · met", "Aug 10–16 · below target"]}
      />
    );

    const trigger = screen.getByText("Weekly details");
    expect(trigger.tagName).toBe("SUMMARY");
    const details = trigger.closest("details");
    expect(details?.hasAttribute("open")).toBe(false);
    fireEvent.click(trigger);
    expect(details?.hasAttribute("open")).toBe(true);
    expect(screen.getByText("Aug 3–9 · met")).toBeTruthy();
    expect(screen.getByText("Aug 10–16 · below target")).toBeTruthy();
    expect(trigger.classList.contains("button-control")).toBe(true);
  });

  it("renders nothing for an empty visualization", () => {
    const { container } = render(
      <VisualizationDetails label="Details" items={[]} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("names the visual for assistive technology without saying it out loud", () => {
    render(
      <VisualizationDetails
        label="History"
        aria-label="Weight, last 90 days history details"
        items={["72 kg · 25 Aug"]}
      />
    );
    const trigger = screen.getByLabelText(
      "Weight, last 90 days history details"
    );
    expect(trigger.tagName).toBe("SUMMARY");
    expect(trigger.textContent).toBe("History");
  });

  // THE `!` MUST NOT COME BACK (#3896). `button-control` renders at the 44px phone
  // floor and sheds it from sm upward; an `!important` min-size on the summary
  // outranks that reset at EVERY width, which is how all 18 consumers ended up
  // pinned at the phone floor on the desktop. Rendered geometry proves the sizes;
  // this proves the cascade the sizes rest on.
  describe("compiled CSS (#3518 proof tier)", () => {
    let compiled = "";
    let planted = "";

    beforeAll(async () => {
      const classes = summaryClasses();
      expect(classes).toContain("button-control");
      compiled = await compileFor(classes);
      planted = await compileFor([...classes, "min-h-11!", "min-w-11!"]);
    });

    it("emits no !important min-size on the summary", () => {
      expect(
        minSizeDeclarations(compiled).filter(
          (declaration) => declaration.important
        )
      ).toEqual([]);
    });

    it("keeps button-control's own compact reset above sm", () => {
      const root = postcss.parse(compiled);
      const reset: string[] = [];
      root.walkAtRules("media", (atRule) => {
        if (atRule.params.replace(/\s+/g, " ").trim() !== SM) return;
        atRule.walkDecls(/^min-(block|inline)-size$/, (declaration) => {
          if (/\.button-control(?![\w-])/.test(owningSelector(declaration)))
            reset.push(`${declaration.prop}: ${declaration.value}`);
        });
      });
      expect(reset.toSorted()).toEqual([
        "min-block-size: 0",
        "min-inline-size: 0",
      ]);
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
});
