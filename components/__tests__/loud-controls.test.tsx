import fs from "node:fs";
import path from "node:path";
import postcss, { type Rule } from "postcss";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import Button from "@/components/Button";
import { DestructiveSubmit } from "@/components/SubmitButton";
import { loudIn } from "./loud-controls";

// THE LOUD-CONTROL DEFINITION ITSELF (#5696). The rank specs across the #4978
// programme count a card's fills; this pins what they are counting, in the one
// case that used to escape every one of them.

afterEach(cleanup);

function card(children: React.ReactNode) {
  render(
    <div className="card" data-testid="card">
      {children}
    </div>
  );
  return screen.getByTestId("card");
}

describe("a card's loud controls", () => {
  it("counts a DestructiveSubmit beside the card's commit", () => {
    // The commit alone: one loud control, which is the budget ruling 6 allows.
    expect(loudIn(card(<Button variant="primary">Save</Button>))).toEqual([
      "Save",
    ]);
    cleanup();

    // Add a destructive submit beside it and the card is loud TWICE. This is the
    // assertion that used to be impossible: `.destructive-submit` painted the
    // fill onto a rank-less child, so a card-budget spec expecting `["Save"]`
    // stayed green while the card rendered a second solid control. Every rank
    // spec that expects an exact array now reddens when one is added.
    const withDestructive = card(
      <>
        <Button variant="primary">Save</Button>
        <DestructiveSubmit>Disconnect</DestructiveSubmit>
      </>
    );
    expect(loudIn(withDestructive)).toEqual(["Save", "Disconnect"]);

    // The rank is on the BUTTON, not on the wrapper: the wrapper still supplies
    // the `.btn-danger` geometry, and it is a fill only because the button says
    // so — which is what keeps the paint and the rank from drifting apart again.
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    expect(disconnect.className).toContain("button-control-danger");
    expect(disconnect.parentElement?.className).toBe("destructive-submit");
  });

  it("leaves a control with no rank out of the count", () => {
    expect(
      loudIn(
        card(
          <>
            <Button variant="primary">Save</Button>
            <Button>Cancel</Button>
          </>
        )
      )
    ).toEqual(["Save"]);
  });
});

// jsdom gives `import.meta.url` an http origin, so the repo is anchored on the
// vitest root instead — the same directory every project in vitest.config.ts
// runs from. (Same technique as button-control-cascade.test.tsx.)
const GLOBALS = path.join(process.cwd(), "app/globals.css");

/** A declaration that paints one of the two solid control fills. */
const fillDeclaration = (prop: string, value: string) =>
  prop === "background-color" && /var\(--(?:btn|danger-btn)\b/.test(value);
/** The same fill spelled as a Tailwind utility inside `@apply`. */
const fillUtility = (params: string) =>
  /(?:^|\s)bg-\(--(?:btn|danger-btn)\b/.test(params);

describe("nothing but a rank class may fill a control", () => {
  it("has no @utility painting a fill onto a .button-control descendant", () => {
    const root = postcss.parse(fs.readFileSync(GLOBALS, "utf8"), {
      from: GLOBALS,
    });
    const offenders: string[] = [];
    root.walkAtRules("utility", (utility) => {
      utility.walkRules((rule: Rule) => {
        if (!rule.selector.includes(".button-control")) return;
        const paints =
          rule.some(
            (node) =>
              node.type === "decl" && fillDeclaration(node.prop, node.value)
          ) ||
          rule.some(
            (node) =>
              node.type === "atrule" &&
              node.name === "apply" &&
              fillUtility(node.params)
          );
        if (paints) offenders.push(`${utility.params} { ${rule.selector} }`);
      });
    });

    // A wrapper that fills its `.button-control` child leaves that button with
    // no rank class, and `loudIn` — like every reader of the rendered DOM — has
    // no way to tell it from a quiet control. Two such utilities existed; both
    // were converted to state the rank on the button (#5696). Adding a third
    // would silently re-open the budget's blind spot, so it fails here instead.
    expect(offenders).toEqual([]);
  });
});
