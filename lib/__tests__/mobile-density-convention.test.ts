import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// The phone density conventions (issue #3466) — a source scan in the tradition of
// bottom-edge-tokens.test.ts, over the two spacing layers that #3466 stepped down.
//
// The regression this freezes is NOT "the numbers changed". It is the one #3466
// was filed to prevent: eight per-file numbers instead of one convention. A sweep
// that lands `max-sm:p-3` at eight call sites has spent the effort and bought
// nothing, because the ninth sub-panel added next month inherits nothing — so the
// value of this work is entirely in there being exactly ONE place each step is
// written, and this test is what makes that checkable.
//
// Four rules:
//   1. app/globals.css declares every tier of both conventions, once each.
//   2. Every tier is a `max-sm:` override carrying `!`. This is the DESKTOP-SAFETY
//      proof and it is structural rather than measured: a `max-sm:` variant emits
//      only inside `@media (width < 40rem)`, so at >=`sm` these classes contribute
//      nothing at all and there is no per-site desktop value to get wrong. (Checked
//      against the compiled sheet while #3466 was written: all seven rules land
//      inside that one media query, `!important` included, and nowhere else.) The
//      `!` is load-bearing for the OTHER direction — Tailwind 4 sorts custom
//      utilities independently of source order, so without it a call site's own
//      `p-4` could win the tie and the convention would apply or not depending on
//      generated order.
//   3. Every site #3466 enumerated still carries its tier class, next to the inset
//      it steps down FROM. The pair is the review moment: a call site that changes
//      its desktop padding has to come here and re-pick its tier.
//   4. NOBODY outside app/globals.css hand-writes a phone step for these two
//      properties. This is the rule that keeps a second convention from quietly
//      appearing beside the first, which is the actual failure mode #3466 names.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GLOBALS = "app/globals.css";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// A class token, not a substring. `subpanel-inset` is a PREFIX of
// `subpanel-inset-xs`, `section-seam` of `section-seam-lg`, `section-stack` of
// `section-stack-sm` — so a `toContain` check lets any tier be swapped for its
// own longer sibling with the census still green, and a 16-in-16 box could
// silently step to 8px instead of 12px. Every tier assertion below goes through
// here.
function classToken(name: string): RegExp {
  return new RegExp(
    `(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`
  );
}

function hasClass(source: string, name: string): boolean {
  return classToken(name).test(source);
}

// THE CLASS TEXT A BROWSER WOULD ACTUALLY SEE — or a THROWN error.
//
// This is the shape the whole class-B check turns on, and the reason it is not
// simply "return whatever sits in the className slot". An ABSENCE assertion over
// UNRESOLVED text FAILS OPEN: `hasClass(x, "card") === false` is satisfied by any
// text that does not literally contain `card`, and a bare identifier qualifies.
// So extracting a long className to a module-scope const — the most routine edit
// in this codebase — silently blinded this guard and BOTH card-in-card nests
// could be restored with the whole suite green. Anchoring on the tag did not help:
// the hole was never the anchor, it was reading text nobody had resolved.
//
// Note the asymmetry, because it is why this went unnoticed: a PRESENCE assertion
// over the same unresolved text fails LOUDLY (the `p-0!` premise below died on
// exactly this refactor, naming the identifier it could not read). Only absence
// fails open, and absence is what class B is made of.
//
// So: resolve same-file consts, then read only literal text — and if anything is
// left that could contribute class text and cannot be read, THROW. A red saying
// "make this className readable" is the correct outcome; a green is not.
function classTextOf(source: string, needle: string): string {
  const syntax = ts.createSourceFile(
    "probe.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let target: OpeningTag | null = null;
  const visit = (node: ts.Node) => {
    if (
      target == null &&
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.getText(syntax).includes(needle)
    )
      target = node;
    if (target == null) ts.forEachChild(node, visit);
  };
  visit(syntax);
  if (!target) throw new Error(`no element carries ${needle}`);
  const variants = classVariantsOf(
    target,
    syntax,
    moduleConstInitializers(syntax)
  );
  if (variants.length === 0)
    throw new Error(`${needle}'s tag has no className`);
  const unresolved = [
    ...new Set(variants.flatMap((variant) => variant.unresolved)),
  ];
  if (unresolved.length > 0)
    throw new Error(
      `${needle}'s className cannot be read: ${unresolved.join(", ")}. ` +
        "An absence assertion over unresolved text fails open."
    );
  return variants.map((variant) => variant.text).join(" ");
}

// tier -> the phone value it sets. Desktop is whatever the call site already had.
const TIERS = new Map<string, string>([
  // Class A — a padded box INSIDE a padded card. Keyed by the inset the box
  // carries today, because that is what a call site looks at to pick one.
  ["subpanel-inset", "p-3"], // from p-4 (16) / p-4 sm:p-5
  ["subpanel-inset-sm", "p-2.5"], // from p-3 (12)
  ["subpanel-inset-xs", "p-2"], // from p-2.5 (10)
  // Class C — the vertical seam BETWEEN page sections.
  ["section-seam", "mb-4"], // from mb-6 (24)
  ["section-seam-lg", "mb-6"], // from mb-8 (32)
  ["section-stack", "space-y-6"], // from space-y-10 (40)
  ["section-stack-sm", "space-y-4"], // from space-y-6 (24)
]);

// Every site #3466's table names, plus the same-shape siblings on the same card
// that the convention has to reach for the surface to read as one thing: file ->
// (tier, the inset it steps down from). A new sub-panel is added here, which is
// the point — the list is a census, not a changelog.
const SITES: ReadonlyArray<readonly [string, string, string]> = [
  // A. Boxed sub-panels inside cards, worst first (the issue's own order).
  ["app/(app)/settings/ai/AiTierSettings.tsx", "subpanel-inset", "p-4"],
  ["components/practices/PracticeTrends.tsx", "subpanel-inset", "p-4 sm:p-5"],
  ["app/(app)/settings/server/BackupSettings.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/settings/server/SmtpSettings.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/settings/family/FamilyManager.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/training/TrainingWatchCard.tsx", "subpanel-inset-sm", "p-3"],
  ["components/FindingRow.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/training/EndurancePlanBar.tsx", "subpanel-inset-sm", "py-3"],
  ["app/(app)/training/MuscleCoverageCard.tsx", "subpanel-inset-xs", "p-2.5"],
  ["app/(app)/encounters/AppointmentList.tsx", "subpanel-inset-sm", "p-3"],
  ["app/(app)/longevity/PillarStat.tsx", "subpanel-inset-xs", "p-2.5"],
  // B. The unwrapped card-in-card, which lands as a sub-panel of its host card.
  ["components/IntegrationSyncHistoryLink.tsx", "subpanel-inset", "p-4"],
  // C. The seams the sweep flagged by name.
  ["app/(app)/records/VisitsSection.tsx", "section-stack", "space-y-10"],
  ["app/(app)/records/VisitsSection.tsx", "section-stack-sm", "space-y-6"],
  ["app/(app)/whats-new/page.tsx", "section-stack-sm", "space-y-6"],
  // The stack the /longevity seam collapses against. Censused because an
  // un-stepped stack beside a stepped seam renders the LARGER of the two, so this
  // line is load-bearing for a margin declared two files away.
  ["app/(app)/longevity/page.tsx", "section-stack-sm", "space-y-6"],
  ["app/(app)/results/BioAgeInputsCard.tsx", "section-seam", "mb-6"],
  ["components/dashboard/DashboardAhead.tsx", "section-seam-lg", "mb-8"],
  [
    "components/dashboard/DashboardStandingCluster.tsx",
    "section-seam-lg",
    "mb-8",
  ],
  ["app/(app)/wellness/page.tsx", "section-seam-lg", "mb-8"],
];

// Rule 4's scan, and its width is the point. The first version read
// `max-sm:(p-…|mb-…|space-y-…)`, which catches `max-sm:mb-4` and lets
// `max-sm:px-3`, `max-sm:pt-2`, `max-sm:py-2.5`, `max-sm:mt-3` and
// `max-sm:space-x-2` walk straight past — half the spellings of the very thing
// the rule exists to stop, in a guard whose whole job is that nobody starts a
// second convention. A guard that can only see the spelling its author had in
// mind turns "nobody has done this" into "nobody can do this", and only the
// first is true.
//
// It matches a phone-scoped padding, margin or space STEP: a numeric value on
// `p`/`m` with any direction, or on `space-x`/`space-y`. It deliberately does NOT
// match `-auto` alignment (`max-sm:ml-auto` and `max-sm:mr-auto` both ship today
// and are not spacing steps), nor `gap-*`, which is intra-component layout rather
// than either of the two gutter layers this convention owns. Both silences are
// asserted below, because a guard that cries wolf on shipped, correct code is
// deleted within a week and takes the real guard with it.
const OWNED_STEP =
  /max-sm:-?(?:[mp][trblxy]?|space-[xy])-\d+(?:\.\d+)?(?![\w-])/;

// The three test directories are excluded and nothing else is: a spec that NAMES
// the forbidden spelling in order to argue about it — this file does, twice — is
// not a call site, and a guard that fires on its own source gets deleted.
const NOT_A_CALL_SITE = /^lib\/__(tests|db_tests|action_tests)__\//;

function sourceFiles(root = REPO): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) out.push(rel);
    }
  };
  for (const d of ["app", "components", "lib"]) {
    if (fs.existsSync(path.join(root, d))) walk(d);
  }
  return out.filter((f) => !NOT_A_CALL_SITE.test(f));
}

type OpeningTag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

type DelegatedGutterScan = {
  cards: string[];
  cells: { role: string; site: string }[];
  offenders: string[];
};

type ClassVariant = { text: string; unresolved: string[] };

type ClassRead = {
  text: string | null;
  variants: ClassVariant[];
  error?: string;
};

function combineClassVariants(
  left: ClassVariant[],
  right: ClassVariant[]
): ClassVariant[] {
  const combined = left.flatMap((a) =>
    right.map((b) => ({
      text: `${a.text} ${b.text}`.trim(),
      unresolved: [...a.unresolved, ...b.unresolved],
    }))
  );
  const unique = new Map<string, ClassVariant>();
  for (const variant of combined) {
    const key = `${variant.text}\0${variant.unresolved.join("\0")}`;
    unique.set(key, variant);
  }
  return [...unique.values()];
}

function moduleConstInitializers(
  source: ts.SourceFile
): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>();
  for (const statement of source.statements) {
    if (
      !ts.isVariableStatement(statement) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    )
      continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer)
        initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  return initializers;
}

// Resolve the finite set of class strings an expression can render. Conditions
// contribute BRANCHES, never a union: a role is valid only when every reachable
// branch carries its whole gutter. Same-file const aliases recurse to a fixed
// point with an explicit cycle report. Class combiners are transparent over
// their arguments; an arbitrary helper is unresolved and therefore fails any
// card/cell whose contract depends on it.
function classVariantsOf(
  tag: OpeningTag,
  syntax: ts.SourceFile,
  consts: Map<string, ts.Expression>
): ClassVariant[] {
  const attribute = tag.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === "className"
  );
  if (!attribute?.initializer) return [];
  if (ts.isStringLiteral(attribute.initializer))
    return [{ text: attribute.initializer.text, unresolved: [] }];
  if (
    !ts.isJsxExpression(attribute.initializer) ||
    !attribute.initializer.expression
  )
    return [{ text: "", unresolved: ["unrecognised className initializer"] }];

  const evaluate = (
    expression: ts.Expression,
    stack: readonly string[] = []
  ): ClassVariant[] => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    )
      current = current.expression;

    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current)
    )
      return [{ text: current.text, unresolved: [] }];
    if (
      current.kind === ts.SyntaxKind.TrueKeyword ||
      current.kind === ts.SyntaxKind.FalseKeyword ||
      current.kind === ts.SyntaxKind.NullKeyword ||
      ts.isNumericLiteral(current)
    )
      return [{ text: "", unresolved: [] }];
    if (ts.isIdentifier(current)) {
      if (current.text === "undefined") return [{ text: "", unresolved: [] }];
      const initializer = consts.get(current.text);
      if (!initializer)
        return [{ text: "", unresolved: [`identifier ${current.text}`] }];
      if (stack.includes(current.text))
        return [
          {
            text: "",
            unresolved: [
              `const cycle ${[...stack, current.text].join(" -> ")}`,
            ],
          },
        ];
      return evaluate(initializer, [...stack, current.text]);
    }
    if (ts.isConditionalExpression(current))
      return [
        ...evaluate(current.whenTrue, stack),
        ...evaluate(current.whenFalse, stack),
      ];
    if (ts.isTemplateExpression(current)) {
      let variants: ClassVariant[] = [
        { text: current.head.text, unresolved: [] },
      ];
      for (const span of current.templateSpans) {
        variants = combineClassVariants(
          variants,
          evaluate(span.expression, stack).map((variant) => ({
            ...variant,
            text: `${variant.text}${span.literal.text}`,
          }))
        );
      }
      return variants;
    }
    if (ts.isBinaryExpression(current)) {
      if (current.operatorToken.kind === ts.SyntaxKind.PlusToken)
        return combineClassVariants(
          evaluate(current.left, stack),
          evaluate(current.right, stack)
        );
      if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
        return [
          { text: "", unresolved: [] },
          ...evaluate(current.right, stack),
        ];
      return [
        {
          text: "",
          unresolved: [`binary expression ${current.getText(syntax)}`],
        },
      ];
    }
    if (ts.isCallExpression(current)) {
      const callee = current.expression.getText(syntax);
      let variants: ClassVariant[] = [{ text: "", unresolved: [] }];
      for (const argument of current.arguments)
        variants = combineClassVariants(variants, evaluate(argument, stack));
      if (["cn", "clsx", "classNames", "twMerge"].includes(callee))
        return variants;
      return variants.map((variant) => ({
        ...variant,
        unresolved: [...variant.unresolved, `helper call ${callee}`],
      }));
    }
    if (ts.isArrayLiteralExpression(current)) {
      let variants: ClassVariant[] = [{ text: "", unresolved: [] }];
      for (const element of current.elements) {
        if (ts.isSpreadElement(element))
          return [
            {
              text: variants.map((variant) => variant.text).join(" "),
              unresolved: [`spread ${element.getText(syntax)}`],
            },
          ];
        variants = combineClassVariants(variants, evaluate(element, stack));
      }
      return variants;
    }
    return [
      {
        text: "",
        unresolved: [`expression ${current.getText(syntax)}`],
      },
    ];
  };

  return evaluate(attribute.initializer.expression);
}

function jsxAttribute(tag: OpeningTag, name: string): string | null {
  const attribute = tag.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name
  );
  if (!attribute) return null;
  if (!attribute.initializer) return "<boolean>";
  if (ts.isStringLiteral(attribute.initializer))
    return attribute.initializer.text;
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression &&
    (ts.isStringLiteral(attribute.initializer.expression) ||
      ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression))
  ) {
    return attribute.initializer.expression.text;
  }
  return "<dynamic>";
}

function jsxAttributeSource(tag: OpeningTag, name: string): string | null {
  const attribute = tag.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name
  );
  return attribute?.initializer?.getText() ?? null;
}

function directRenderedChildTags(tag: OpeningTag): OpeningTag[] {
  if (!ts.isJsxOpeningElement(tag)) return [];
  const children: OpeningTag[] = [];
  const findOutermost = (node: ts.Node) => {
    if (ts.isJsxElement(node)) {
      children.push(node.openingElement);
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      children.push(node);
      return;
    }
    ts.forEachChild(node, findOutermost);
  };
  for (const child of tag.parent.children) findOutermost(child);
  return children;
}

// One relationship owns every zero-padding card rather than a named assertion
// for each current site. The attributes make the two halves visible at the tag:
// the card declares that its gutter is delegated, and one or more DIRECT cells
// declare which existing horizontal gutter they carry. The role preserves the
// intentionally different phone values without pretending this family has one
// number. A direct local component is resolved to its rendered root; the marker
// must live on that DOM carrier, never merely on `<ReadingsHeader />` where it
// can disappear instead of being forwarded.
function scanDelegatedCardGutters(root = REPO): DelegatedGutterScan {
  const result: DelegatedGutterScan = { cards: [], cells: [], offenders: [] };

  for (const rel of sourceFiles(root).filter((file) => file.endsWith(".tsx"))) {
    const source = fs.readFileSync(path.join(root, rel), "utf8");
    const syntax = ts.createSourceFile(
      rel,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const consts = moduleConstInitializers(syntax);
    const tags: OpeningTag[] = [];
    const componentRoots = new Map<string, OpeningTag>();
    const unwrapJsx = (expression: ts.Expression): OpeningTag | null => {
      let current = expression;
      while (ts.isParenthesizedExpression(current))
        current = current.expression;
      if (ts.isJsxElement(current)) return current.openingElement;
      if (ts.isJsxSelfClosingElement(current)) return current;
      return null;
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        tags.push(node);
      }
      if (ts.isFunctionDeclaration(node) && node.name && node.body) {
        const returned = node.body.statements.find(ts.isReturnStatement);
        if (returned?.expression) {
          const rootTag = unwrapJsx(returned.expression);
          if (rootTag) componentRoots.set(node.name.text, rootTag);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);

    const site = (tag: OpeningTag) => {
      const line =
        syntax.getLineAndCharacterOfPosition(tag.getStart(syntax)).line + 1;
      return `${rel}:${line}`;
    };
    const classCache = new Map<OpeningTag, ClassRead>();
    const classes = (tag: OpeningTag): ClassRead => {
      const cached = classCache.get(tag);
      if (cached) return cached;
      const ownSite = site(tag);
      const classSource = jsxAttributeSource(tag, "className");
      if (classSource == null) {
        const missing = {
          text: null,
          variants: [],
          error: "tag carries no className",
        };
        classCache.set(tag, missing);
        return missing;
      }
      try {
        const variants = classVariantsOf(tag, syntax, consts);
        const unresolved = [
          ...new Set(variants.flatMap((variant) => variant.unresolved)),
        ];
        const resolved = {
          text: variants.map((variant) => variant.text).join(" "),
          variants,
          ...(unresolved.length
            ? {
                error: `${ownSite}'s className cannot be read completely: ${unresolved.join(", ")}`,
              }
            : {}),
        };
        classCache.set(tag, resolved);
        return resolved;
      } catch (error) {
        const failed = { text: null, variants: [], error: String(error) };
        classCache.set(tag, failed);
        return failed;
      }
    };

    const renderedTag = (tag: OpeningTag): OpeningTag => {
      if (jsxAttributeSource(tag, "className") != null) return tag;
      const name = tag.tagName.getText(syntax);
      return componentRoots.get(name) ?? tag;
    };
    const horizontalGutters = (text: string) => {
      const tokens = text.split(/\s+/).filter(Boolean);
      return tokens.filter((token) => {
        const utility = token.split(":").at(-1) ?? token;
        return /^!?(?:p|px|pl|pr)-\S+!?$/.test(utility);
      });
    };
    const gutterRoles: Record<string, readonly string[]> = {
      standard: ["px-4", "sm:px-5"],
      compact: ["px-2", "sm:px-5"],
      action: ["px-2", "sm:px-3"],
    };

    const candidates: OpeningTag[] = [];
    for (const tag of tags) {
      const declaration = jsxAttribute(tag, "data-card-gutter");
      const resolved = classes(tag);
      if (resolved.text == null) {
        if (declaration != null) {
          result.offenders.push(`${site(tag)}: ${resolved.error}`);
        }
        continue;
      }
      const candidateBranches = resolved.variants.filter(
        (variant) =>
          hasClass(variant.text, "card") && hasClass(variant.text, "p-0!")
      );
      const ownSite = site(tag);
      if (
        resolved.error &&
        (declaration != null || candidateBranches.length > 0)
      ) {
        result.offenders.push(`${ownSite}: ${resolved.error}`);
        continue;
      }
      if (candidateBranches.length > 0) {
        candidates.push(tag);
        result.cards.push(ownSite);
        if (candidateBranches.length !== resolved.variants.length) {
          result.offenders.push(
            `${ownSite}: data-card-gutter cannot describe only some className branches; every branch must retain both \`card\` and \`p-0!\``
          );
        }
        if (declaration !== "delegated") {
          result.offenders.push(
            `${ownSite}: a \`card … p-0!\` must declare data-card-gutter="delegated" on that same tag`
          );
        }
      } else if (declaration != null) {
        result.offenders.push(
          `${ownSite}: data-card-gutter="${declaration}" is licensed only on the same tag as both \`card\` and \`p-0!\``
        );
      }
    }

    const ownedRenderedRoots = new Set<OpeningTag>();
    for (const card of candidates) {
      let carriers = 0;
      for (const child of directRenderedChildTags(card)) {
        const effective = renderedTag(child);
        const invocationRole = jsxAttribute(child, "data-card-gutter-cell");
        const role = jsxAttribute(effective, "data-card-gutter-cell");
        const resolved = classes(effective);
        const childSite = site(child);
        const effectiveSite = site(effective);
        if (effective !== child && invocationRole != null) {
          result.offenders.push(
            `${childSite}: data-card-gutter-cell must be declared on the rendered root at ${effectiveSite}; a component invocation cannot substitute for its DOM carrier`
          );
        }
        if (resolved.text == null) {
          if (role != null) {
            result.offenders.push(
              `${effectiveSite}: marked rendered child classes cannot be resolved: ${resolved.error}`
            );
          }
          continue;
        }
        const gutterVariants = resolved.variants.map((variant) => ({
          ...variant,
          gutters: horizontalGutters(variant.text),
        }));
        const carriesGutter = gutterVariants.some(
          (variant) => variant.gutters.length > 0
        );
        if (!carriesGutter && role == null) continue;
        carriers += 1;
        ownedRenderedRoots.add(effective);

        if (role == null) {
          result.offenders.push(
            `${effectiveSite}: this rendered direct child carries horizontal padding but does not declare data-card-gutter-cell`
          );
          continue;
        }
        result.cells.push({ role, site: effectiveSite });
        const expected = gutterRoles[role];
        if (!expected) {
          result.offenders.push(
            `${effectiveSite}: unknown delegated gutter role \`${role}\``
          );
        } else {
          for (const [index, variant] of gutterVariants.entries()) {
            const found = [...variant.gutters].sort();
            const wanted = [...expected].sort();
            if (
              variant.unresolved.length > 0 ||
              found.length !== wanted.length ||
              found.some((token, tokenIndex) => token !== wanted[tokenIndex])
            ) {
              result.offenders.push(
                `${effectiveSite}: the ${role} gutter cell must carry exactly \`${expected.join(" ")}\` horizontally in every className branch; branch ${index + 1} found \`${variant.gutters.join(" ") || "none"}\`${variant.unresolved.length ? ` with unresolved ${variant.unresolved.join(", ")}` : ""}`
              );
            }
          }
        }
        for (const tier of TIERS.keys()) {
          if (tier.startsWith("subpanel-") && hasClass(resolved.text, tier)) {
            result.offenders.push(
              `${effectiveSite}: a delegated gutter cell is the card's own gutter, not a ${tier} sub-panel`
            );
          }
        }
      }
      if (carriers === 0) {
        result.offenders.push(
          `${site(card)}: a delegated card has no rendered direct child carrying its gutter`
        );
      }
    }

    for (const tag of tags) {
      const role = jsxAttribute(tag, "data-card-gutter-cell");
      if (role != null && !ownedRenderedRoots.has(tag)) {
        result.offenders.push(
          `${site(tag)}: a gutter cell must be a rendered direct child of a delegated card`
        );
      }
    }
  }
  return result;
}

function scanDelegatedGutterFixture(
  source: string,
  file = "Offender.tsx"
): DelegatedGutterScan {
  const root = makeTmpDir("card-gutter-census");
  try {
    fs.mkdirSync(path.join(root, "app"));
    fs.mkdirSync(path.join(root, "components"));
    fs.writeFileSync(path.join(root, "components", file), source);
    return scanDelegatedCardGutters(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("phone density conventions (#3466)", () => {
  const css = read(GLOBALS);

  it("rule 1+2: every tier is declared once in app/globals.css, as a max-sm override carrying !", () => {
    for (const [tier, phoneValue] of TIERS) {
      const declarations = [
        ...css.matchAll(new RegExp(`@utility ${tier} \\{`, "g")),
      ];
      expect(
        declarations.length,
        `${tier} must be declared exactly once in ${GLOBALS} — it is the single place its phone step is written`
      ).toBe(1);

      // The body, verbatim and WHOLE. `toContain` was not enough and the comment
      // here already promised more than it delivered: `@apply sm:p-6;` could be
      // added beside the step and the tier would still "contain" its own
      // spelling — putting a desktop value inside the one construction whose
      // entire guarantee is that it cannot have one.
      const opened = css.indexOf(`@utility ${tier} {`);
      const body = css
        .slice(opened + `@utility ${tier} {`.length, css.indexOf("}", opened))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
      expect(
        body,
        `${tier}'s body must be EXACTLY '@apply max-sm:${phoneValue}!;' and nothing else — the max-sm variant is what makes desktop identical by construction, and the ! is what makes the convention beat a call site's own padding regardless of Tailwind's generated order`
      ).toBe(`@apply max-sm:${phoneValue}!;`);
    }
  });

  it("rule 3: every site #3466 enumerated carries its tier next to the inset it steps down from", () => {
    for (const [file, tier, from] of SITES) {
      const src = read(file);
      expect(
        hasClass(src, tier),
        `${file} must carry ${tier} as its own class token (#3466) — a substring match here would accept ${tier}-sm or ${tier}-xs in its place, which is a different step`
      ).toBe(true);
      expect(
        src,
        `${file} must still carry its own '${from}' — the convention is an ADDITION beside the desktop vocabulary, never a replacement for it; a site that drops it has moved its desktop value too`
      ).toContain(from);
    }
  });

  it("rule 4: nobody outside app/globals.css hand-writes a phone step for these properties", () => {
    const offenders = sourceFiles().filter((f) => OWNED_STEP.test(read(f)));
    expect(
      offenders,
      "a per-file `max-sm:p-*` / `max-sm:mb-*` / `max-sm:space-y-*` is the second convention #3466 exists to prevent — add a tier to app/globals.css and use it"
    ).toEqual([]);
  });

  // A green sweep over a COMPLYING tree says nothing about what the sweep can see.
  // Rule 4's pattern is run here over sources authored to BREAK it and over the
  // benign neighbours it must stay quiet on — the second half matters as much as
  // the first, because a guard that fires on shipped, correct code gets deleted
  // and takes the real guard with it.
  it("rule 4's pattern can SEE every spelling of the step, and stays quiet on what is not one", () => {
    const caught = [
      'className="max-sm:p-3"', // the shape the original pattern already saw
      'className="max-sm:px-3"', // …and five it did not
      'className="max-sm:py-2.5"',
      'className="max-sm:pt-2"',
      'className="max-sm:pb-1"',
      'className="max-sm:mt-3"',
      'className="max-sm:mb-4"',
      'className="max-sm:m-2"',
      'className="max-sm:-mt-2"', // a negative step is still a step
      'className="max-sm:space-x-2"',
      'className="max-sm:space-y-4"',
      "className={`flex ${x} max-sm:pl-2`}", // inside a template literal
    ];
    for (const source of caught) {
      expect(
        OWNED_STEP.test(source),
        `rule 4 must SEE ${source} — a guard blind to the spelling everyone reaches for turns "nobody has done this" into "nobody can do this"`
      ).toBe(true);
    }

    const quiet = [
      'className="max-sm:ml-auto"', // ships today (ProtocolControls) — alignment, not a step
      'className="max-sm:mr-auto"', // ships today (ActivityPartsList) — same
      'className="max-sm:mx-auto"',
      'className="sm:p-3"', // a DESKTOP value is not this convention's business
      'className="p-3 sm:p-4"',
      'className="max-sm:flex max-sm:flex-wrap"',
      'className="max-sm:min-h-10"', // a tap floor, not a gutter
      'className="max-sm:gap-2"', // intra-component layout, neither gutter layer
      'className="max-sm:rounded-none"',
      'className="subpanel-inset section-seam"', // the convention itself
    ];
    for (const source of quiet) {
      expect(
        OWNED_STEP.test(source),
        `rule 4 must stay QUIET on ${source} — it is not a phone-scoped padding or margin step, and a guard that cries wolf on it will be deleted`
      ).toBe(false);
    }
  });

  // The same question one level down, for the tier names themselves.
  it("a tier is matched as a class token, never as a prefix of its longer sibling", () => {
    expect(hasClass('className="subpanel-inset-xs"', "subpanel-inset")).toBe(
      false
    );
    expect(hasClass('className="section-seam-lg"', "section-seam")).toBe(false);
    expect(hasClass('className="section-stack-sm"', "section-stack")).toBe(
      false
    );
    // …while the real thing still matches, beside other classes and inside a
    // template literal.
    expect(
      hasClass('className="p-4 subpanel-inset flex"', "subpanel-inset")
    ).toBe(true);
    expect(
      hasClass("className={`mb-6 section-seam ${x}`}", "section-seam")
    ).toBe(true);
  });

  // The resolver itself, because every absence assertion in this file rests on it
  // and an absence assertion over text nobody resolved passes while the thing it
  // forbids is present. Forged sources, both directions.
  it("class text is RESOLVED or the read THROWS — an absence check may never pass on text it cannot read", () => {
    const tag = (className: string, extra = "") =>
      `${extra}\n<div data-testid="probe" className=${className} />`;

    // READABLE: the value is literal text, wherever it comes from.
    expect(classTextOf(tag('"card p-4"'), 'data-testid="probe"')).toContain(
      "card"
    );
    expect(
      classTextOf(tag('{`card ${x ? "a" : "b"}`}'), 'data-testid="probe"')
    ).toContain("card");
    // …including a same-file module const, which is the refactor that blinded
    // this guard: BOTH card-in-card nests were restorable with the suite green.
    expect(
      classTextOf(
        tag("{LINK_CLASS}", 'const LINK_CLASS =\n  "card subpanel-inset p-4";'),
        'data-testid="probe"'
      )
    ).toContain("card");
    // A ternary's branches are BOTH in scope — for an absence check the union is
    // the conservative direction.
    expect(
      classTextOf(tag('{cond ? "card" : "p-4"}'), 'data-testid="probe"')
    ).toContain("card");

    // UNREADABLE: each of these must THROW rather than return text that happens
    // not to contain the forbidden class.
    const unreadable = [
      [
        "{LINK_CLASS}",
        "a const this file cannot see (imported, or declared in a scope)",
      ],
      ['{cn("flex", styles.card)}', "a helper call"],
      ["{props.className}", "a prop"],
      ["{`flex ${styles.wrapper}`}", "a member expression inside a hole"],
      ["{makeClass()}", "a factory"],
    ];
    for (const [expression, why] of unreadable) {
      expect(
        () => classTextOf(tag(expression), 'data-testid="probe"'),
        `${expression} (${why}) must THROW — an absence assertion over it would pass while the class was present`
      ).toThrow(/cannot be read/);
    }
  });

  it("every zero-padding card declares its delegated gutter and a direct cell role (#3507)", () => {
    const scan = scanDelegatedCardGutters();
    expect(
      scan.offenders,
      "A `card … p-0!` spends its gutter in direct inner cells. Declare both halves on their own tags; these are card gutters, not sub-panel insets."
    ).toEqual([]);

    // Corpus reach, not a frozen ceiling: the four wrappers #3507 found must
    // remain visible, while a correctly declared sixth site inherits the scan.
    expect(
      scan.cards.length,
      "the delegated-card census no longer reaches all four wrappers #3507 found"
    ).toBeGreaterThanOrEqual(4);
    const roles = scan.cells.map((cell) => cell.role);
    expect(
      roles.filter((role) => role === "standard").length,
      "the two 16px-phone delegated gutters #3507 found must remain in the census"
    ).toBeGreaterThanOrEqual(2);
    expect(
      roles.filter((role) => role === "compact").length,
      "MetricReadingsTable's two 8px-phone branches must remain in the census"
    ).toBeGreaterThanOrEqual(2);
  });

  // Each offender is planted alone as a real TSX file in the same corpus walker
  // the production assertion uses. Keeping the attacks independent prevents one
  // loud failure from masking a survivor beside it.
  it.each([
    {
      name: "an undeclared literal candidate",
      source: `export function Offender() {
        return <section className="card overflow-hidden p-0!">
          <div className="px-4 sm:px-5" data-card-gutter-cell="standard" />
        </section>;
      }`,
      message: 'must declare data-card-gutter="delegated" on that same tag',
    },
    {
      name: "a marker whose parent took padding back",
      source: `export function Offender() {
        return <section className="card overflow-hidden p-4" data-card-gutter="delegated">
          <div className="px-4 sm:px-5" data-card-gutter-cell="standard" />
        </section>;
      }`,
      message: "is licensed only on the same tag as both `card` and `p-0!`",
    },
    {
      name: "a changed compact role",
      source: `export function Offender() {
        return <section className="card overflow-hidden p-0!" data-card-gutter="delegated">
          <div className="px-4 sm:px-5" data-card-gutter-cell="compact" />
        </section>;
      }`,
      message:
        "the compact gutter cell must carry exactly `px-2 sm:px-5` horizontally",
    },
    {
      name: "an unmarked sibling beside a correct cell",
      source: `export function Offender() {
        return <section className="card overflow-hidden p-0!" data-card-gutter="delegated">
          <div className="px-4 sm:px-5" data-card-gutter-cell="standard" />
          <div className="px-3 sm:px-6" />
        </section>;
      }`,
      message:
        "this rendered direct child carries horizontal padding but does not declare data-card-gutter-cell",
    },
    {
      name: "a changed rendered component root",
      source: `export function Offender() {
        return <section className="card overflow-hidden p-0!" data-card-gutter="delegated"><Header /></section>;
      }
      function Header() {
        return <div className="px-3 sm:px-6" data-card-gutter-cell="standard" />;
      }`,
      message:
        "the standard gutter cell must carry exactly `px-4 sm:px-5` horizontally",
    },
    {
      name: "a marker only on a component invocation",
      source: `export function Offender() {
        return <section className="card overflow-hidden p-0!" data-card-gutter="delegated">
          <Header data-card-gutter-cell="standard" />
        </section>;
      }
      function Header(_props: { "data-card-gutter-cell": "standard" }) {
        return <div className="px-4 sm:px-5" />;
      }`,
      message: "a component invocation cannot substitute for its DOM carrier",
    },
    {
      name: "a conditional branch without a gutter",
      source: `export function Offender({ menu }: { menu: boolean }) {
        return <section className="card overflow-hidden p-0!" data-card-gutter="delegated">
          <div className={\`flex \${menu ? "px-4 sm:px-5" : ""}\`} data-card-gutter-cell="standard" />
        </section>;
      }`,
      message: "branch 2 found `none`",
    },
    {
      name: "a later responsive horizontal override",
      source: `export function Offender() {
        return <section className="card overflow-hidden p-0!" data-card-gutter="delegated">
          <div className="px-4 sm:px-5 md:px-8" data-card-gutter-cell="standard" />
        </section>;
      }`,
      message: "branch 1 found `px-4 sm:px-5 md:px-8`",
    },
    {
      name: "a five-deep candidate const chain",
      source: `const FIVE_5 = "card overflow-hidden p-0!";
      const FIVE_4 = FIVE_5;
      const FIVE_3 = FIVE_4;
      const FIVE_2 = FIVE_3;
      const FIVE_1 = FIVE_2;
      export function Offender() {
        return <section className={FIVE_1}><div className="px-4 sm:px-5" /></section>;
      }`,
      message: 'must declare data-card-gutter="delegated" on that same tag',
    },
    {
      name: "a candidate const cycle",
      source: `const CARD_A = \`card overflow-hidden p-0! \${CARD_B}\`;
      const CARD_B = CARD_A;
      export function Offender() {
        return <section className={CARD_A} data-card-gutter="delegated">
          <div className="px-4 sm:px-5" data-card-gutter-cell="standard" />
        </section>;
      }`,
      message: "const cycle CARD_A -> CARD_B -> CARD_A",
    },
    {
      name: "a card candidate inside a class combiner",
      source: `const CARD_CLASSES = "card overflow-hidden p-0!";
      export function Offender() {
        return <section className={cn(CARD_CLASSES)}><div className="px-4 sm:px-5" /></section>;
      }`,
      message: 'must declare data-card-gutter="delegated" on that same tag',
    },
  ])("catches $name", ({ source, message }) => {
    expect(scanDelegatedGutterFixture(source).offenders.join("\n")).toContain(
      message
    );
  });

  it("does not classify a non-card p-0! class helper as a delegated card", () => {
    const scan = scanDelegatedGutterFixture(
      `const ICON_BUTTON_CLASSES = "btn-ghost p-0!";
      export function IconButton() {
        return <button className={cn(ICON_BUTTON_CLASSES)} aria-label="More" />;
      }`,
      "Quiet.tsx"
    );
    expect(scan).toEqual({ cards: [], cells: [], offenders: [] });
  });

  it("the two card-in-card nests draw one border each (#3466 class B)", () => {
    // /data mounts IntegrationsGrid — itself a grid of `.card`s — so its wrapper
    // may not be one. Read off the WRAPPER'S OWN tag, located by its id: the page
    // has many legitimate cards.
    const dataPage = read("app/(app)/data/page.tsx");
    expect(
      hasClass(classTextOf(dataPage, 'id="integrations"'), "card"),
      "the integrations wrapper may not be a `.card` — the grid inside it already draws one border per source"
    ).toBe(false);

    // The takeout page's Status card is this link's only host, and it mounts it
    // INSIDE that card. Anchored on the link's OWN tag for the same reason the
    // wrapper above is anchored on its id, and it was NOT before: matching the
    // first `className=` in the file reads `SyncTimestamp`'s the moment this
    // component's own className becomes a template literal, so `card` could be
    // re-hardcoded here and both assertions would pass — on an element nobody
    // asked about.
    const link = read("components/IntegrationSyncHistoryLink.tsx");
    expect(
      hasClass(classTextOf(link, 'data-testid="sync-history-link"'), "card"),
      "IntegrationSyncHistoryLink may not hardcode `card` on itself — every host it has mounts it inside one"
    ).toBe(false);
  });
});
