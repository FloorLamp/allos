import fs from "node:fs";
import path from "node:path";
import postcss, {
  type AtRule,
  type Container,
  type Declaration,
  type Node,
  type Rule,
} from "postcss";
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

// THE RULE THE GUARD ENFORCES: inside `app/globals.css`, no rule may paint
// `--btn` / `--danger-btn` onto an element it reaches through a COMBINATOR. The
// fill has to land on the element the rule's own subject is — which, for a
// control, is the element carrying the rank class. That is one sentence rather
// than a list of known wrapper names, and it is what makes the paint and the
// rank the same fact instead of two that can drift.
//
// WHAT IT DOES NOT SEE, stated because a guard's silence is worth nothing
// unless its edge is known: only `app/globals.css` is read, and only these two
// tokens. A control filled with an arbitrary colour (`@apply bg-emerald-700` on
// a child) is off-palette rather than a rank the census misses, and belongs to
// the token discipline, not the loud budget. Both are pinned as cases below so
// the edge is executable rather than asserted in a comment.

/** A declaration that paints one of the two solid control fills. */
const fillDeclaration = (decl: Declaration) =>
  decl.prop === "background-color" &&
  /var\(\s*--(?:btn|danger-btn)\b/.test(decl.value);
/** The same fill spelled as a Tailwind utility inside `@apply`. */
const fillUtility = (atRule: AtRule) =>
  atRule.name === "apply" &&
  /(?:^|\s)bg-\(--(?:btn|danger-btn)\b/.test(atRule.params);

/** The `@utility` this node is written inside, if any. */
const utilityOf = (node: Container | Node): AtRule | null => {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "atrule" && (p as AtRule).name === "utility")
      return p as AtRule;
  }
  return null;
};

/**
 * The rule a declaration actually belongs to, looking THROUGH `@media` and the
 * other conditional at-rules. Without this a fill moved inside a `@media` block
 * reads as belonging to no rule at all.
 */
const enclosingRule = (node: Container | Node): Rule | null => {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "rule") return p as Rule;
    if (p.type === "atrule" && (p as AtRule).name === "utility") return null;
  }
  return null;
};

const branches = (selector: string) =>
  selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

/** A nested selector that steps off `&` onto something underneath it. */
const nestedDescends = (selector: string) =>
  branches(selector).some((part) => {
    if (!part.startsWith("&")) return true; // a bare nested selector is a descendant
    const rest = part.slice(1);
    return /^\s*[>+~]/.test(rest) || /^\s+\S/.test(rest);
  });

/** The same question for a top-level selector, which has no `&` to step off. */
const absoluteDescends = (selector: string) =>
  branches(selector).some((part) =>
    // Parenthesised argument lists (`:not(…)`, `:is(…)`) are not combinators.
    /[>+~]|\S\s+\S/.test(part.replace(/\([^)]*\)/g, ""))
  );

/** Does this rule paint a fill of its own, rather than in a nested rule? */
const paintsFill = (rule: Rule) => {
  let painted = false;
  rule.walkDecls((decl) => {
    if (enclosingRule(decl) === rule && fillDeclaration(decl)) painted = true;
  });
  rule.walkAtRules((atRule) => {
    if (enclosingRule(atRule) === rule && fillUtility(atRule)) painted = true;
  });
  return painted;
};

/**
 * Every rule in `css` that paints a control fill onto something below its own
 * subject, named by the chain that reaches it.
 *
 * Takes CSS TEXT so the same walker runs over the real stylesheet and over
 * planted cases. `postcss.parse` on a string is the whole walker, not a matcher
 * fed a string: discovery and recognition are the same code path either way.
 */
export function wrapperFills(css: string, from = "planted.css"): string[] {
  const offenders: string[] = [];
  postcss.parse(css, { from }).walkRules((rule: Rule) => {
    if (!paintsFill(rule)) return;
    const chain: string[] = [];
    let descends = false;
    for (let node: Rule | null = rule; node; node = enclosingRule(node)) {
      chain.unshift(node.selector.replace(/\s+/g, " "));
      const relative = utilityOf(node) !== null || enclosingRule(node) !== null;
      if ((relative ? nestedDescends : absoluteDescends)(node.selector))
        descends = true;
    }
    const utility = utilityOf(rule);
    if (descends)
      offenders.push(
        `${utility ? `@utility ${utility.params}` : "(top level)"} { ${chain.join(" ")} }`
      );
  });
  return offenders;
}

// The two blocks this change retired, copied from the tree they were deleted
// from, plus the shapes a later author would reach for writing the same defect
// in the file's own house style. These are the positive control: without them
// the assertion below is `[] === []` over a corpus nothing proves is readable.
const OFFENDERS = [
  {
    name: "the retired duplicate-resolution-primary, verbatim",
    css: `@utility duplicate-resolution-primary {
        @apply contents;
        & > .button-control:not(:disabled) {
          @apply border-transparent bg-(--btn) text-(--btn-fg) hover:bg-(--btn-hover);
        }
      }`,
  },
  {
    name: "the destructive-submit this change converted, verbatim",
    css: `@utility destructive-submit {
        @apply contents;
        & > .button-control {
          @apply gap-2 border-transparent bg-(--danger-btn) px-4 text-sm text-(--danger-btn-fg);
        }
      }`,
  },
  {
    name: "the fill spelled as a raw declaration rather than @apply",
    css: `@utility w { & > .button-control { background-color: var(--btn); } }`,
  },
  {
    // THE HOUSE-STYLE EVASION. `&:not(:disabled)` nested inside is how
    // `button-control-primary` and `button-control-danger` scope away from the
    // family's one disabled treatment, so it is the shape the next author
    // writing a wrapper reaches for — and a guard reading only a rule's
    // immediate children never sees it.
    name: "the fill one level deeper, in the file's own disabled-scoping idiom",
    css: `@utility w {
        & > .button-control {
          &:not(:disabled) { @apply bg-(--btn); }
        }
      }`,
  },
  {
    name: "a child named by element rather than by the control class",
    css: `@utility w { & > button { @apply bg-(--danger-btn); } }`,
  },
  {
    name: "a child not named at all",
    css: `@utility w { & > * { @apply bg-(--btn); } }`,
  },
  {
    name: "the fill inside a @media block within the child rule",
    css: `@utility w {
        & > .button-control {
          @media (min-width: 40rem) { @apply bg-(--btn); }
        }
      }`,
  },
  {
    name: "a hand-written rule outside any @utility",
    css: `.destructive-submit > .button-control { background-color: var(--danger-btn); }`,
  },
] as const;

const BENIGN = [
  {
    // What `destructive-submit` is at this head: the retiring `.btn-danger`
    // SHAPE on the child and no paint at all.
    name: "a wrapper that gives its child geometry and no fill",
    css: `@utility destructive-submit {
        @apply contents;
        & > .button-control {
          @apply gap-2 px-4 text-sm shadow-xs;
          border-radius: var(--radius-control);
        }
      }`,
  },
  {
    // The rank utilities themselves, verbatim in shape: the fill lands on the
    // utility's OWN element. This is the case a stricter "no fill near a
    // control" rule would break, and it has to keep passing.
    name: "a rank utility painting its own element",
    css: `@utility button-control-primary {
        &:not(:disabled):not([aria-disabled="true"]) {
          border-color: transparent;
          background-color: var(--btn);
          color: var(--btn-fg);
        }
        &:not(:disabled):not([aria-disabled="true"]):hover {
          background-color: var(--btn-hover);
        }
      }`,
  },
  {
    // OUT OF SCOPE, PINNED SO THE EDGE IS EXECUTABLE. An arbitrary colour on a
    // child is off-palette, which is the token discipline's question, not the
    // loud budget's — the census reads rank classes, and this paints none.
    name: "an off-palette fill on a child, which this guard does not own",
    css: `@utility w { & > .button-control { @apply bg-emerald-700; } }`,
  },
] as const;

describe("nothing but a rank class may fill a control", () => {
  // A wrapper that fills a control it merely contains leaves that button with
  // no rank class, and `loudIn` — like every reader of the rendered DOM — has
  // no way to tell it from a quiet control. Two such utilities existed; both
  // now state the rank on the button (#5696). A third would silently re-open
  // the budget's blind spot, so it fails here instead.
  it("finds no such fill in app/globals.css", () => {
    expect(wrapperFills(fs.readFileSync(GLOBALS, "utf8"), GLOBALS)).toEqual([]);
  });

  it.each(OFFENDERS)("catches $name", ({ css }) => {
    expect(wrapperFills(css)).not.toEqual([]);
  });

  it.each(BENIGN)("leaves alone $name", ({ css }) => {
    expect(wrapperFills(css)).toEqual([]);
  });
});
