import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  CREATE_VERB,
  HOUSINGS,
  RETIRED_CREATE_VERBS,
  UnreadableAffordanceError,
  findCreateAffordances,
  housingAt,
  leadingVerb,
  sameFileLiterals,
  verbIsCurrent,
  withoutComments,
  type CreateAffordance,
  type Housing,
} from "../add-affordance-grammar";

// ONE VERB AND ONE PLACEMENT FOR THE ADD AFFORDANCE (#3486), swept over the tree.
//
// The rule itself is `lib/add-affordance-grammar.ts`; this file is what keeps it
// true. It is the fail-closed shape `lib/__tests__/overflow-menu-identity.test.ts`
// established, because both rules have the same dangerous form: **"no button says
// New X" is an ABSENCE assertion, and an absence assertion goes green the moment
// the scan stops finding buttons.** A rename, a directory move, a JSX shape the
// reader cannot parse — every one of those looks exactly like compliance.
//
// So, in order:
//
//   1. the census clears a FLOOR before a single affordance is judged;
//   2. an affordance the scan cannot READ throws, rather than being skipped;
//   3. the rule is then applied — and separately proved able to SEE, by running
//      it over sources written to break it, and proved QUIET on the benign
//      neighbours that would get it deleted if it cried wolf.
//
// Comments are blanked before matching. This repo's own subject files explain the
// rule in prose — `AddEntryPanel` quotes "+ Add result" to say what `addLabel` is
// for, `GoalsManager` names its own button in a layout comment — and a scan over
// raw source reads prose as code (#3509: an e2e census once counted a `.first()`
// written in an English sentence).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const ROOTS = ["app", "components"];

// THE FLOOR THE CENSUS MUST CLEAR. Not the exact count — add affordances arrive
// with every feature and this file is not a changelog — but a number well above
// zero, so a sweep that has stopped seeing them fails LOUDLY instead of passing
// over an empty list. Measured 2026-08-22: 81 affordances across 66 files. It
// only ever moves up, and only when someone has looked.
const CENSUS_FLOOR = 65;

// The files that DEFINE an affordance primitive rather than mount one. Their
// button's name is a prop expression by design — that is the whole point of a
// primitive — so there is no literal for this scan to judge and the mounts are
// where the judging happens.
const PRIMITIVE_FILES = new Map<string, string>([
  [
    "components/AddEntryPanel.tsx",
    "the #1497 rare-cadence disclosure itself; its button renders `addLabel ?? label` and every mount is judged below",
  ],
]);

// PRIMARY CREATES WHOSE PLACEMENT A HUMAN SIGNED OFF, each with the reason. The
// chokepoint-register discipline this repo already uses for anatomy exceptions:
// an entry is a decision somebody made in this file, not a string that slipped
// past a scan.
const PLACEMENT_REGISTER = new Map<string, string>([
  [
    "components/photo/PhotoCapture.tsx",
    "The trigger's class AND its placement are both the caller's: `className ?? " +
      '"btn"` means this file only supplies the primary treatment as a fallback, and ' +
      "every mount is a row affordance inside a photo strip. There is no placement " +
      "claim here to judge — the strips that mount it make it.",
  ],
]);

// AFFORDANCES WHOSE NAME IS THE CALLER'S, registered so the unreadable-throw
// stays a real signal rather than a thing people learn to route around.
//
// The throw exists because a control this scan cannot READ is a control the rule
// has silently stopped governing. A component that takes its name as a required
// prop is the honest version of that, and the answer is not to weaken the throw
// but to say where the names actually live so the next reader can go and check
// them.
const CALLER_NAMED = new Map<string, string>([
  [
    "components/facts/FactChipRow.tsx",
    "`FactAddChip` takes a required `label` naming the fact it adds; the strings are " +
      "in each consumer's fact module (`moreFactsLabel` and its siblings), not here",
  ],
]);

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), {
      withFileTypes: true,
    })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("."))
          continue;
        walk(rel);
      } else if (entry.name.endsWith(".tsx")) {
        out.push(rel);
      }
    }
  };
  for (const root of ROOTS) walk(root);
  return out.sort();
}

type Found = CreateAffordance & { file: string };

function census(): Found[] {
  const out: Found[] = [];
  for (const file of sourceFiles()) {
    if (PRIMITIVE_FILES.has(file)) continue;
    const source = withoutComments(read(file));
    let affordances: CreateAffordance[];
    try {
      affordances = findCreateAffordances(source);
    } catch (error) {
      if (error instanceof UnreadableAffordanceError) {
        if (CALLER_NAMED.has(file)) continue;
        throw new UnreadableAffordanceError(
          `${file}: ${error.message} If the name genuinely belongs to the caller, ` +
            "register the file in CALLER_NAMED in this test with where its strings live."
        );
      }
      throw error;
    }
    for (const a of affordances) out.push({ ...a, file });
  }
  return out;
}

/**
 * The component a file default-exports, by filename. Enough for the one question
 * asked of it: a create affordance living alone in its own component file is
 * placed by whoever MOUNTS it, so the mount is where placement is read.
 */
function componentName(file: string): string {
  return path.basename(file, ".tsx");
}

/** Every housing this component is mounted in, across the tree. */
function mountHousings(name: string): {
  housings: (Housing | null)[];
  mounts: string[];
} {
  const housings: (Housing | null)[] = [];
  const mounts: string[] = [];
  for (const file of sourceFiles()) {
    const source = withoutComments(read(file));
    for (const m of source.matchAll(new RegExp(`<${name}(?=[\\s/>])`, "g"))) {
      mounts.push(`${file}:${source.slice(0, m.index).split("\n").length}`);
      housings.push(housingAt(source, m.index));
    }
  }
  return { housings, mounts };
}

type TrainingCreateAuthentication = {
  issues: string[];
  mountLines: number[];
};

/**
 * Authenticate the imported binding, its sole live reference, and the control
 * flow that owns that reference. A component-name search alone can be
 * counterfeited by aliasing the binding and leaving the expected spelling in a
 * string or comment; a gate check alone can sit inside an outer false/dynamic
 * wrapper. The TypeScript tree connects all three claims.
 */
function authenticateTrainingCreate(
  source: string
): TrainingCreateAuthentication {
  const file = ts.createSourceFile(
    "app/(app)/training/page.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const issues: string[] = [];
  const importsFrom = (specifier: string) =>
    file.statements.filter(
      (statement): statement is ts.ImportDeclaration =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text === specifier
    );
  const imports = importsFrom("./AddTrainingActivityButton");
  const canonical = imports.filter(
    (statement) =>
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.name?.text === "AddTrainingActivityButton" &&
      statement.importClause.namedBindings === undefined
  );
  if (imports.length !== 1 || canonical.length !== 1)
    issues.push("canonical-import");

  const tabImports = importsFrom("@/components/TabFirstPage");
  const canonicalTab = tabImports.filter(
    (statement) =>
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.name?.text === "TabFirstPage" &&
      statement.importClause.namedBindings === undefined
  );
  if (tabImports.length !== 1 || canonicalTab.length !== 1)
    issues.push("canonical-tab-first-page-import");

  const importedName = canonical[0]?.importClause?.name;
  const importedTabName = canonicalTab[0]?.importClause?.name;
  const references: ts.Identifier[] = [];
  const tabReferences: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === "AddTrainingActivityButton" &&
      node !== importedName
    )
      references.push(node);
    if (
      ts.isIdentifier(node) &&
      node.text === "TabFirstPage" &&
      node !== importedTabName
    )
      tabReferences.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);

  const tabOpenings = tabReferences.filter(
    (
      reference
    ): reference is ts.Identifier & { parent: ts.JsxOpeningElement } =>
      ts.isJsxOpeningElement(reference.parent) &&
      reference.parent.tagName === reference
  );
  const tabClosings = tabReferences.filter(
    (reference) =>
      ts.isJsxClosingElement(reference.parent) &&
      reference.parent.tagName === reference
  );
  const tabMount = tabOpenings[0]?.parent.parent;
  if (
    tabReferences.length !== 2 ||
    tabOpenings.length !== 1 ||
    tabClosings.length !== 1 ||
    !tabMount ||
    !ts.isJsxElement(tabMount) ||
    tabClosings[0].parent.parent !== tabMount
  )
    issues.push("sole-tab-first-page-mount");

  const tabActionAttributes =
    tabMount && ts.isJsxElement(tabMount)
      ? tabMount.openingElement.attributes.properties.filter(
          (attribute): attribute is ts.JsxAttribute =>
            ts.isJsxAttribute(attribute) &&
            ts.isIdentifier(attribute.name) &&
            attribute.name.text === "action"
        )
      : [];
  const hasTabSpread =
    tabMount &&
    ts.isJsxElement(tabMount) &&
    tabMount.openingElement.attributes.properties.some((attribute) =>
      ts.isJsxSpreadAttribute(attribute)
    );
  if (tabActionAttributes.length !== 1 || hasTabSpread)
    issues.push("sole-tab-first-page-action");
  if (references.length !== 1) issues.push("sole-binding-reference");

  const mounts = references.filter(
    (
      reference
    ): reference is ts.Identifier & {
      parent: ts.JsxSelfClosingElement;
    } =>
      ts.isJsxSelfClosingElement(reference.parent) &&
      reference.parent.tagName === reference
  );
  if (mounts.length !== 1) issues.push("sole-jsx-mount");

  const mount = mounts[0]?.parent;
  const gate = mount?.parent;
  const condition =
    gate &&
    ts.isBinaryExpression(gate) &&
    gate.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
    gate.right === mount
      ? gate.left
      : undefined;
  const exactLogCondition =
    condition &&
    ts.isBinaryExpression(condition) &&
    condition.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
    ts.isIdentifier(condition.left) &&
    condition.left.text === "activeTab" &&
    ts.isStringLiteral(condition.right) &&
    condition.right.text === "log";
  if (!exactLogCondition) issues.push("direct-log-gate");

  const actionInitializer = tabActionAttributes[0]?.initializer;
  const gateExpression = gate?.parent;
  const actionContainer = gateExpression?.parent;
  if (
    !actionInitializer ||
    !ts.isJsxExpression(actionInitializer) ||
    !gateExpression ||
    !ts.isJsxExpression(gateExpression) ||
    gateExpression.expression !== gate ||
    !actionContainer ||
    !ts.isJsxElement(actionContainer) ||
    actionInitializer.expression !== actionContainer ||
    !actionContainer.children.includes(gateExpression)
  )
    issues.push("direct-tab-action-value");

  if (gate) {
    let cursor: ts.Node = gate;
    let owner: ts.Node | undefined;
    while (cursor.parent) {
      const parent = cursor.parent;
      if (ts.isFunctionLike(parent)) {
        owner = parent;
        break;
      }
      if (
        (ts.isBinaryExpression(parent) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(parent.operatorToken.kind)) ||
        ts.isConditionalExpression(parent) ||
        ts.isIfStatement(parent) ||
        ts.isForStatement(parent) ||
        ts.isForInStatement(parent) ||
        ts.isForOfStatement(parent) ||
        ts.isWhileStatement(parent) ||
        ts.isDoStatement(parent) ||
        ts.isSwitchStatement(parent)
      )
        issues.push("enclosing-control-flow");
      cursor = parent;
    }
    if (
      !owner ||
      !ts.isFunctionDeclaration(owner) ||
      owner.name?.text !== "TrainingPage" ||
      !owner.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword
      )
    )
      issues.push("training-page-owner");

    if (owner && ts.isFunctionDeclaration(owner)) {
      let returnStatement: ts.ReturnStatement | undefined;
      let returnCursor: ts.Node | undefined = tabMount;
      let untransformedReturnPath = true;
      while (returnCursor && returnCursor !== owner) {
        if (ts.isReturnStatement(returnCursor)) {
          returnStatement = returnCursor;
          break;
        }
        const parent: ts.Node = returnCursor.parent;
        if (
          !ts.isJsxElement(parent) &&
          !ts.isJsxFragment(parent) &&
          !ts.isParenthesizedExpression(parent) &&
          !ts.isReturnStatement(parent)
        )
          untransformedReturnPath = false;
        returnCursor = parent;
      }
      const body = owner.body;
      const directReturn = Boolean(
        body &&
        returnStatement &&
        returnStatement.parent === body &&
        body.statements.includes(returnStatement) &&
        untransformedReturnPath
      );
      let priorAbrupt = false;
      if (directReturn && body && returnStatement) {
        const returnIndex = body.statements.indexOf(returnStatement);
        const containsAbrupt = (node: ts.Node): boolean => {
          if (node !== owner && ts.isFunctionLike(node)) return false;
          if (ts.isReturnStatement(node) || ts.isThrowStatement(node))
            return true;
          return node.getChildren(file).some(containsAbrupt);
        };
        priorAbrupt = body.statements
          .slice(0, returnIndex)
          .some(containsAbrupt);
      }
      if (!directReturn || priorAbrupt) issues.push("direct-return-path");
    }
  }

  return {
    issues: [...new Set(issues)],
    mountLines: mounts.map(
      (reference) =>
        file.getLineAndCharacterOfPosition(reference.getStart(file)).line + 1
    ),
  };
}

describe("the add affordance's grammar (#3486)", () => {
  const found = census();

  // THE CENSUS ITSELF, ASSERTED BEFORE ANYTHING IS JUDGED. Every rule below is a
  // per-affordance verdict, and a verdict over an empty list is green and says
  // nothing at all.
  it("finds the add affordances it is about to judge", () => {
    const files = new Set(found.map((a) => a.file));
    expect(
      found.length,
      `Found ${found.length} add affordances in ${files.size} files under ` +
        `${ROOTS.join("/")}, below the floor of ${CENSUS_FLOOR}. Either this scan has ` +
        "stopped seeing them (a rename, a move, a JSX shape it cannot parse) or the " +
        "affordances really are gone — check which before lowering this number."
    ).toBeGreaterThanOrEqual(CENSUS_FLOOR);
    // All four spellings, so a scan that has lost one of them is loud rather than
    // merely smaller. `entry-panel` is the one that matters most: it is the most
    // common spelling in the tree and the one a `<button>`-only scan would miss
    // entirely (#3325's shape).
    expect(new Set(found.map((a) => a.kind))).toContain("entry-panel");
    expect(new Set(found.map((a) => a.kind))).toContain("button");
  });

  it(`says "${CREATE_VERB} X" and never "${RETIRED_CREATE_VERBS.join("/")} X"`, () => {
    const retired = found
      .filter((a) => a.verb !== CREATE_VERB)
      .map((a) => `${a.file}:${a.line} — "${a.label}"`);
    expect(
      retired,
      `An add affordance leads with a retired verb. #3486 ruled ONE verb for the ` +
        `create act: "${CREATE_VERB} X". "New X" was the minority and it converts — ` +
        "including the dialog heading the trigger opens, because a trigger and its " +
        "heading saying different words is the same defect at one moment instead of " +
        "across two screens."
    ).toEqual([]);
  });

  it("houses every page-level and section-level create", () => {
    const unhoused: string[] = [];
    for (const a of found) {
      if (!a.primary) continue;
      if (a.housing !== null) continue;
      if (PLACEMENT_REGISTER.has(a.file)) continue;
      // Spelling 4: the affordance is its own component and its placement is
      // decided by whoever mounts it. Resolve one level and judge there.
      const { housings, mounts } = mountHousings(componentName(a.file));
      if (mounts.length > 0 && housings.every((h) => h !== null)) continue;
      unhoused.push(
        mounts.length === 0
          ? `${a.file}:${a.line} — "${a.label}" (primary, no housing in this file and no mount found)`
          : `${a.file}:${a.line} — "${a.label}" (primary; mounted unhoused at ${mounts
              .filter((_, i) => housings[i] === null)
              .join(", ")})`
      );
    }
    expect(
      unhoused,
      "A page-level or section-level create is unhoused — the 'mid-page, " +
        "left-aligned' row of #3486's placement table. A primary create belongs in " +
        "the page header's `action` (the page's one primary), in a section's own " +
        "heading row (`CardSectionHeader`'s `action`, or the `justify-between` row " +
        "that carries the section's heading), in a `<form>` as a submit, or inside " +
        "an `AddEntryPanel` disclosure. A create that genuinely belongs in none of " +
        "those is a decision someone should record in PLACEMENT_REGISTER in this " +
        "file, with the reason."
    ).toEqual([]);
  });

  it("houses the Training Log primary in the existing page-header action", () => {
    const subject = found.filter(
      (a) =>
        a.file === "app/(app)/training/AddTrainingActivityButton.tsx" &&
        a.label === "Add activity"
    );
    expect(
      subject,
      "The Training Log's Add activity primary must remain in the affordance census"
    ).toHaveLength(1);
    expect(subject[0].primary).toBe(true);

    const { housings, mounts } = mountHousings("AddTrainingActivityButton");
    expect(mounts.map((mount) => mount.replace(/:\d+$/, ""))).toEqual([
      "app/(app)/training/TrainingLogView.tsx",
      "app/(app)/training/page.tsx",
    ]);
    expect(housings).toEqual(["page-header", "page-header"]);
    const pageSource = read("app/(app)/training/page.tsx");
    expect(
      authenticateTrainingCreate(pageSource).issues,
      "The page header must use the exact imported AddTrainingActivityButton binding once, directly behind the sole activeTab === log gate in TrainingPage"
    ).toEqual([]);

    // The exact escape this replaces: an unconditional mount plus the expected
    // expression left in a JSX comment. A raw `toContain` sees the sentence;
    // the TSX tree sees that the only live mount has no gate.
    const hostile = pageSource.replace(
      '{activeTab === "log" && <AddTrainingActivityButton />}',
      '<AddTrainingActivityButton />\n            {/* activeTab === "log" && <AddTrainingActivityButton /> */}'
    );
    expect(hostile).not.toBe(pageSource);
    expect(authenticateTrainingCreate(hostile).issues).toContain(
      "direct-log-gate"
    );

    const duplicateCreate = pageSource.replace(
      "<AddTrainingActivityButton />",
      "<><AddTrainingActivityButton /><AddTrainingActivityButton /></>"
    );
    expect(duplicateCreate).not.toBe(pageSource);
    expect(authenticateTrainingCreate(duplicateCreate).issues).toContain(
      "sole-binding-reference"
    );

    const aliasedCreate = pageSource
      .replace(
        'import AddTrainingActivityButton from "./AddTrainingActivityButton";',
        'import AddTrainingActivityButton from "./AddTrainingActivityButton";\nconst TrainingCreate = AddTrainingActivityButton;'
      )
      .replace("<AddTrainingActivityButton />", "<TrainingCreate />");
    expect(aliasedCreate).not.toBe(pageSource);
    expect(authenticateTrainingCreate(aliasedCreate).issues).toContain(
      "sole-jsx-mount"
    );

    const ariaHiddenCreate = pageSource.replace(
      "<AddTrainingActivityButton />",
      '<span aria-hidden="true"><AddTrainingActivityButton /></span>'
    );
    expect(ariaHiddenCreate).not.toBe(pageSource);
    expect(authenticateTrainingCreate(ariaHiddenCreate).issues).toEqual(
      expect.arrayContaining(["direct-log-gate", "direct-tab-action-value"])
    );

    const reversed = pageSource.replace(
      'activeTab === "log" && <AddTrainingActivityButton />',
      '"log" === activeTab && <AddTrainingActivityButton />'
    );
    expect(reversed).not.toBe(pageSource);
    expect(authenticateTrainingCreate(reversed).issues).toContain(
      "direct-log-gate"
    );

    for (const transformedGate of [
      '[activeTab === "log" && <AddTrainingActivityButton />]',
      'Boolean(activeTab === "log" && <AddTrainingActivityButton />)',
      '(activeTab === "log" && <AddTrainingActivityButton />, null)',
    ]) {
      const transformed = pageSource.replace(
        '{activeTab === "log" && <AddTrainingActivityButton />}',
        `{${transformedGate}}`
      );
      expect(transformed).not.toBe(pageSource);
      expect(authenticateTrainingCreate(transformed).issues).toContain(
        "direct-tab-action-value"
      );
    }

    const transformedReturns = [
      pageSource.replace(
        "  return (\n    // Width cap",
        "  return Boolean(\n    // Width cap"
      ),
      pageSource
        .replace("  return (\n    // Width cap", "  return [\n    // Width cap")
        .replace("\n  );\n}\n\nfunction one(", "\n  ];\n}\n\nfunction one("),
      pageSource.replace(
        "\n  );\n}\n\nfunction one(",
        "\n    , null);\n}\n\nfunction one("
      ),
    ];
    for (const transformed of transformedReturns) {
      expect(transformed).not.toBe(pageSource);
      expect(authenticateTrainingCreate(transformed).issues).toContain(
        "direct-return-path"
      );
    }

    for (const outer of ["false", "showTrainingCreate"]) {
      const wrapped = pageSource.replace(
        '{activeTab === "log" && <AddTrainingActivityButton />}',
        `{${outer} && (activeTab === "log" && <AddTrainingActivityButton />)}`
      );
      expect(wrapped).not.toBe(pageSource);
      expect(authenticateTrainingCreate(wrapped).issues).toContain(
        "enclosing-control-flow"
      );
    }

    const priorReturn = pageSource.replace(
      "  return (\n    // Width cap",
      "  return null;\n  return (\n    // Width cap"
    );
    expect(priorReturn).not.toBe(pageSource);
    expect(authenticateTrainingCreate(priorReturn).issues).toContain(
      "direct-return-path"
    );

    const finallyOverride = pageSource
      .replace(
        "  return (\n    // Width cap",
        "  try {\n    return (\n    // Width cap"
      )
      .replace(
        "\n  );\n}\n\nfunction one(",
        "\n    );\n  } finally {\n    return null;\n  }\n}\n\nfunction one("
      );
    expect(finallyOverride).not.toBe(pageSource);
    expect(authenticateTrainingCreate(finallyOverride).issues).toContain(
      "direct-return-path"
    );

    const tabAlias = pageSource
      .replace(
        'import TabFirstPage from "@/components/TabFirstPage";',
        'import TrainingTabs from "@/components/TabFirstPage";'
      )
      .replaceAll("<TabFirstPage", "<TrainingTabs")
      .replaceAll("</TabFirstPage>", "</TrainingTabs>");
    expect(tabAlias).not.toBe(pageSource);
    expect(authenticateTrainingCreate(tabAlias).issues).toEqual(
      expect.arrayContaining([
        "canonical-tab-first-page-import",
        "sole-tab-first-page-mount",
      ])
    );

    const extraTabMount = pageSource.replace(
      '<PageContainer width="wide" className="mx-auto">',
      '<PageContainer width="wide" className="mx-auto">\n      <TabFirstPage config={TRAINING_TAB_FIRST_PAGE} />'
    );
    expect(extraTabMount).not.toBe(pageSource);
    expect(authenticateTrainingCreate(extraTabMount).issues).toContain(
      "sole-tab-first-page-mount"
    );

    const duplicateAction = pageSource.replace(
      'testId="training-page"',
      'testId="training-page" action={null}'
    );
    expect(duplicateAction).not.toBe(pageSource);
    expect(authenticateTrainingCreate(duplicateAction).issues).toContain(
      "sole-tab-first-page-action"
    );

    const spreadActionOverride = pageSource.replace(
      'testId="training-page"',
      'testId="training-page" {...{ action: null }}'
    );
    expect(spreadActionOverride).not.toBe(pageSource);
    expect(authenticateTrainingCreate(spreadActionOverride).issues).toContain(
      "sole-tab-first-page-action"
    );

    const aliasDecoy = pageSource
      .replace(
        'import AddTrainingActivityButton from "./AddTrainingActivityButton";',
        'import TrainingCreate from "./AddTrainingActivityButton";'
      )
      .replace(
        '{activeTab === "log" && <AddTrainingActivityButton />}',
        '<TrainingCreate />\n            {activeTab === "log" && "<AddTrainingActivityButton />"}'
      );
    expect(aliasDecoy).not.toBe(pageSource);
    expect(authenticateTrainingCreate(aliasDecoy).issues).toEqual(
      expect.arrayContaining([
        "canonical-import",
        "sole-binding-reference",
        "sole-jsx-mount",
      ])
    );
  });

  it("names every icon-only create for AT, because below `sm` it has no other name", () => {
    // #3486's third §4 rule, as the tree actually ships it. The registry used to
    // record "icon-only `+` ... never a page/section primary", and three of the
    // app's page-level primaries are exactly that below `sm` — /wellness's `+`,
    // the supplement add toggle, the metric measurement toggle — with
    // `e2e/button-height-floor.mobile.spec.ts` DEPENDING on the wellness one
    // being icon-only in order to measure the case the height floor exists for.
    // A rule whose own guard requires the opposite is a decision licensed by a
    // claim that is not true, so the rule now describes what ships and this is
    // the half of it a scan can hold.
    //
    // The claim is narrow and load-bearing: the visible label span carries
    // `hidden sm:inline`, and `display: none` removes it from the accessible
    // name computation. Below `sm` the `aria-label` is not a nicety, it is the
    // control's ONLY name — and a phone is where this composition happens.
    const nameless = found
      .filter((a) => a.iconOnlyBelowSm && !a.hasAriaLabel)
      .map((a) => `${a.file}:${a.line} — "${a.label}"`);
    expect(
      nameless,
      "An add affordance hides its label below `sm` (`hidden sm:inline`) and has no " +
        "`aria-label`. `display: none` takes the span out of the accessible name, so " +
        "this control is silently NAMELESS on a phone — the one viewport where it is " +
        "icon-only. Give it an `aria-label`, or let it keep its visible label."
    ).toEqual([]);
    // And the composition is really present, so the check above is not green over
    // an empty filter — the same census discipline the file opens with.
    expect(
      found.filter((a) => a.iconOnlyBelowSm).length,
      "No icon-only create found at all. Either the composition is gone or this scan " +
        "has stopped seeing it; the assertion above is meaningless either way."
    ).toBeGreaterThanOrEqual(2);
  });
});

// ── THE HALF THAT MAKES THE GREEN ABOVE WORTH ANYTHING ──────────────────────
//
// A green sweep over a COMPLYING tree says nothing about what the sweep can see.
// Everything below runs the rule over sources written to BREAK it, and over the
// benign neighbours that would get this file deleted if it cried wolf on them.
// The second half is not optional: #3325's census had to stay quiet on five
// shipped `ORDER BY … COLLATE NOCASE` sorts for exactly this reason.

const scan = (source: string) => findCreateAffordances(withoutComments(source));

describe("the sweep can see an offender", () => {
  it("catches the retired verb on a button", () => {
    const found = scan(
      `export default function X() {
         return <div><button type="button" className="btn">New goal</button></div>;
       }`
    );
    expect(found).toHaveLength(1);
    expect(found[0].verb).toBe("New");
    expect(verbIsCurrent(found[0].label)).toBe(false);
  });

  it("catches it inside a ternary, where the label is not a text node", () => {
    // `MedicationAddWorkspace` writes its primary this way. A scan reading only
    // bare JSX text would have found nothing here and reported the page clean.
    const found = scan(
      `<div><button className="btn">{open ? "Close" : "New medication"}</button></div>`
    );
    expect(found.map((a) => a.label)).toEqual(["New medication"]);
  });

  it("catches it on an AddEntryPanel mount, where no button is written at all", () => {
    const found = scan(`<AddEntryPanel panelId="p" label="New result" />`);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("entry-panel");
    expect(found[0].verb).toBe("New");
  });

  it("catches an unhoused primary create", () => {
    const found = scan(
      `<main><p>Some prose.</p>
         <button className="btn">Add a period with dates</button>
       </main>`
    );
    expect(found).toHaveLength(1);
    expect(found[0].primary).toBe(true);
    expect(found[0].housing).toBeNull();
  });

  it("throws on a control it cannot read, rather than skipping it", () => {
    expect(() =>
      scan(`<div><button className="btn"><IconPlus /></button></div>`)
    ).toThrow(UnreadableAffordanceError);
  });

  it("reads the icon-only composition by its aria-label", () => {
    // /wellness's `+`: the visible text is "Add" and the NAME is on the tag.
    const found = scan(
      `<button className="btn" aria-label="Add practice">
         <IconPlus /><span className="hidden sm:inline">Add</span>
       </button>`
    );
    expect(found.map((a) => a.label)).toEqual(["Add practice"]);
  });
});

describe("the sweep stays quiet on the benign neighbours", () => {
  it("reads no affordance out of a comment", () => {
    // The direct #3509 shape. This test file, the rule module and `AddEntryPanel`
    // all quote "New goal" and "+ Add result" in prose in order to say what the
    // rule is; a scan that counted those would fire on its own explanation.
    const found = scan(
      `// The "New goal" button was renamed by #3486.
       /* <button className="btn">New routine</button> */
       export const X = 1;`
    );
    expect(found).toEqual([]);
  });

  it("says nothing about a field placeholder", () => {
    // "New password" is the single most common `^New ` string in the tree and it
    // is not an affordance at all.
    expect(
      scan(`<input placeholder="New password" className="input" />`)
    ).toEqual([]);
  });

  it("says nothing about a toast, a heading, or a generated title", () => {
    expect(
      scan(`<div>
         <h2 className="section-label">New equipment</h2>
         <span>{toast("New protocol run started")}</span>
       </div>`)
    ).toEqual([]);
    // `generateActivityTitle`'s fallback is a stored TITLE, not a label. A sweep
    // that renamed it would have changed data on the strength of a grep.
    expect(
      scan(`<span>{title === "New activity" ? "" : title}</span>`)
    ).toEqual([]);
  });

  it("does not treat a form's row repeater as a placement claim", () => {
    // "+ Add set", "Add reaction", "Add dose" — these add a ROW to an open form.
    // They obey the verb rule (they say "Add") and make no placement claim, and a
    // guard that demanded a header housing for them would be uninstallable.
    const found = scan(
      `<form><input name="a" />
         <button className="btn-ghost">+ Add set</button>
       </form>`
    );
    expect(found).toHaveLength(1);
    expect(found[0].primary).toBe(false);
    expect(found[0].housing).toBe("form");
  });

  it("does not read `Add another …` as a create affordance", () => {
    // `ActivityPartsList`'s repeat control. It is the same act repeated inside an
    // open editor, which is form grammar; its verb is already right.
    expect(leadingVerb("+ Add another activity")).toBeNull();
    expect(
      scan(`<div><button className="btn">+ Add another activity</button></div>`)
    ).toEqual([]);
  });

  it("catches an icon-only create with no accessible name, and stays quiet on a named one", () => {
    const nameless = scan(
      `<button className="btn"><IconPlus /><span className="hidden sm:inline">Add</span></button>`
    );
    expect(nameless[0].iconOnlyBelowSm).toBe(true);
    expect(nameless[0].hasAriaLabel).toBe(false);
    // /wellness's actual shape: the same composition, named.
    const named = scan(
      `<button className="btn" aria-label="Add practice"><IconPlus /><span className="hidden sm:inline">Add</span></button>`
    );
    expect(named[0].iconOnlyBelowSm).toBe(true);
    expect(named[0].hasAriaLabel).toBe(true);
    // A labeled button is not the icon-only composition and is not asked for one.
    expect(
      scan(`<button className="btn">Add practice</button>`)[0].iconOnlyBelowSm
    ).toBe(false);
  });

  it("houses a create in a section heading row, whether the heading is inside it or above it", () => {
    const inside = scan(
      `<div className="flex items-center justify-between">
         <h2>Routines</h2>
         <button className="btn">Add routine</button>
       </div>`
    );
    expect(inside[0].housing).toBe("section-header");
    const above = scan(
      `<section><h2 className="section-label">Manage</h2>
         <div className="flex items-center justify-between">
           <button className="btn">Add supplement</button>
         </div>
       </section>`
    );
    expect(above[0].housing).toBe("section-header");
  });

  it("does not launder a create into form grammar from a distant field", () => {
    // The bound on the field-row housing, asserted rather than assumed. A search
    // box three levels up must not make every create on the page a form submit —
    // that is the direction this rule fails silently in.
    const found = scan(
      `<main><div><input type="search" />
         <div><div><div>
           <button className="btn">Add protocol</button>
         </div></div></div>
       </div></main>`
    );
    expect(found[0].housing).toBeNull();
  });
});

describe("the rule's own vocabulary", () => {
  it("names one verb and the one it retired", () => {
    expect(CREATE_VERB).toBe("Add");
    expect(RETIRED_CREATE_VERBS).toContain("New");
    expect(RETIRED_CREATE_VERBS).not.toContain(CREATE_VERB);
  });

  it("reads a leading verb through the app's `+` glyphs", () => {
    expect(leadingVerb("+ Add protocol")).toBe("Add");
    expect(leadingVerb("＋ Add a login")).toBe("Add");
    expect(leadingVerb("Added 3 items")).toBeNull();
    expect(leadingVerb("Address")).toBeNull();
    expect(leadingVerb("Newsletter")).toBeNull();
  });

  it("resolves a same-file literal so the throw stays a real signal", () => {
    // `LogReadingButton`'s shape: an `IconPlus` control whose name is a prop with
    // a default in the same file. Unresolved, this threw — and a guard that reds
    // on correct code is deleted with the rule inside it.
    const source = `export default function B({ label = "Log reading" }) {
        return <button className="btn btn-sm"><IconPlus />{label}</button>;
      }`;
    expect(sameFileLiterals(source).get("label")).toBe("Log reading");
    expect(scan(source)).toEqual([]);
  });

  it("puts every housing in HOUSINGS, so the register is the only other way out", () => {
    expect(new Set(HOUSINGS)).toEqual(
      new Set(["page-header", "section-header", "form", "disclosure"])
    );
    expect(
      housingAt(`<div><button className="btn">Add x</button></div>`, 5)
    ).toBeNull();
  });
});
