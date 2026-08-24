import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DISCLAIMER_PHRASINGS } from "@/lib/disclaimers";
import { stripComments } from "./strip-comments";

// Copy-lint source-scan (issue #945) — the profile-scoping / telegram-chokepoint /
// notes-text pattern applied to user-facing COPY. It reads every source under the
// human-surface directories as TEXT (no DB, no browser, so it stays "pure" in the
// vitest sense) and fails the build on the small set of MEASURED tone-drift
// patterns the copy standard bans (docs/internals/copy.md):
//
//   (1) Error verb: never "Could not" / "Failed to" / "Unable to" in a user-facing
//       string — the standard is the contraction "Couldn't <verb> <object>."
//   (2) "Please" anywhere — the house voice drops it ("Try again.", not
//       "Please try again."). No exceptions in user copy.
//   (3) Terminal period on the "Couldn't …" error family — a complete-sentence
//       error string ends with terminal punctuation (rule 3); a "Couldn't adopt
//       this template" toast without its period is the drift this catches.
//   (4) Second-person voice on a cross-profile surface — "you" / "your" can only
//       address the active profile, never an aggregate or another person's row.
//   (5) Disclaimer boilerplate outside the canonical /disclaimer surface — domain
//       pages may link there, never hand-write another prose variant.
//
// It is DELIBERATELY narrow (the issue's decision): it catches the drift patterns
// we actually measured, not tone in general — review still owns tone. Comments,
// imports, console/logger calls, and thrown Errors (internal, masked to a generic
// message per #478) are not user-facing and are structurally excluded so they
// can't trip the scan; a genuinely-legitimate hit goes on the frozen allowlist
// with a per-entry justification (the migration-manifest discipline: the allowlist
// only shrinks). A NEW banned phrase in a user-facing string FAILS.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Human-surface directories. The API layer (app/api/**) is intentionally excluded
// from the ERROR-VERB ban: its returned bodies are the #478 generic-error rule's
// turf ("internal error"), not the human-copy standard this test governs.
const SCAN_DIRS = ["app", "components", path.join("lib", "notifications")];
const SCAN_FILES = ["lib/disclaimers.ts"];

// app/api/** is the #478 JSON-error-body layer, not human copy (issue §1, §Non-goals).
const EXCLUDE_SUBPATH = ["app/api/"];

// Cross-profile voice has a narrower surface than the general copy rules. The
// known Household / Family homes and shared subject chips are included explicitly;
// structurally multi-profile components join automatically when they carry the
// ProfileScope, SubjectInfo, or viewIds vocabulary. This makes a new consumer enter
// the scan with its first cross-profile prop instead of relying on a reviewer to
// remember a second registry.
const CROSS_PROFILE_PREFIXES = [
  "app/(app)/household/",
  "app/(app)/settings/family/",
  "components/household/",
];
const CROSS_PROFILE_FILES = new Set([
  "components/dashboard/HouseholdHistoryPromoLink.tsx",
  "components/HouseholdCard.tsx",
  "components/ProfileSwitcherChip.tsx",
  "components/SubjectChip.tsx",
]);
const CROSS_PROFILE_MARKERS = [
  /\bProfileScope\b/,
  /\bSubjectInfo\b/,
  /\bviewIds\b/,
];

// Banned error-verb phrasings and the "please" ban. Case-insensitive: lowercase
// "could not" mid-string is as banned as the capitalized form (rule 1).
const BANNED: { re: RegExp; label: string }[] = [
  {
    re: /\bcould not\b/i,
    label: '"could not" (use the contraction "Couldn\'t")',
  },
  {
    re: /\bfailed to\b/i,
    label: '"failed to" (use "Couldn\'t <verb> <object>.")',
  },
  {
    re: /\bunable to\b/i,
    label: '"unable to" (use "Couldn\'t <verb> <object>.")',
  },
  {
    re: /\bplease\b/i,
    label: '"please" (the house voice drops it — see rule 2)',
  },
];

// The standard error family: a string literal whose content begins with the
// "Couldn't " prefix (straight OR curly apostrophe) is a complete-sentence error
// and must end with terminal punctuation (rule 3). Scoped to this prefix on
// purpose — it is the cheap, unambiguous signature (label/heading fragments don't
// start with "Couldn't "), so the check has no false positives.
const COULDNT_LITERAL = /(["'])(Couldn['’]t [^"']*?)\1/g;
const TERMINAL = /[.?!]$/;

// Disclaimer wording has exactly two source-level homes: the canonical module and
// the page that renders it. The page currently contains no matching literal (it maps
// the module's sections), but keeping both paths explicit records the architectural
// boundary and prevents a domain page from acquiring an ad hoc exception.
const DISCLAIMER_COPY_ALLOW = new Set([
  "lib/disclaimers.ts",
  "app/(app)/disclaimer/page.tsx",
]);
const DISCLAIMER_LINK_TARGET = "/disclaimer#suggestions-and-reference-ranges";
const DISCLAIMER_LINK_SITES = [
  "app/(app)/upcoming/page.tsx",
  "app/(app)/results/clinical-results/view/page.tsx",
];
const MIGRATED_DISCLAIMER_SITES = [
  ...DISCLAIMER_LINK_SITES,
  "app/(app)/trends/BodySection.tsx",
  "components/ProfilePassport.tsx",
  "components/intake/IntakeInteractionNotices.tsx",
];

// Legitimate, justified exceptions. Keyed by (relative path, exact substring) so an
// entry survives ordinary line edits above it. FROZEN — this list only shrinks.
const ALLOW: { file: string; substring: string; why: string }[] = [
  {
    file: "app/(app)/onboarding/actions.ts",
    substring: "The adopted routine could not be activated.",
    why:
      "Internal invariant error thrown inside a writeTx callback — never returned " +
      "to the client; Next masks a thrown Server Action error to a generic message " +
      "(#478). Not user-facing copy, so it keeps its developer-log phrasing.",
  },
];

// Cross-profile copy may address the LOGIN when it describes login-scoped access or
// controls. Those survivors are explicit and frozen; health-data claims do not
// belong here. Keyed by exact substring so ordinary line movement does not churn it.
const FAMILY_LOGIN_COPY =
  "Family settings administers the signed-in login's roster and grants; second " +
  "person addresses that administrator, not any profile's health data.";
const VIEW_CONTROL_COPY =
  "The profile-view controls mutate the signed-in login's view set; second person " +
  "describes that login-owned control state, not a profile's health data.";
const ACTING_IMMUNIZATION_COPY =
  "The schedule assessment is deliberately acting-profile-only even though the " +
  "record list below is multi-view, so second person still names the active profile.";
const ACTING_SUBSTANCE_USE_COPY =
  "Substance use is deliberately NOT multi-view (#2557): its adult-validated " +
  "instruments serve ONE data subject, and that subject is the acting profile — " +
  "which is why its life-stage gate is the only Specialty bit not folded over the " +
  "view set. The route reads viewIds solely to pick a redirect target the sub-tab " +
  "strip is actually showing, so it trips the scope marker while every word it " +
  "renders still names the active profile.";
const CROSS_PROFILE_VOICE_ALLOW: {
  file: string;
  substring: string;
  why: string;
}[] = [
  {
    file: "app/(app)/records/ImmunizationsSection.tsx",
    substring: "You're up to date on the tracked schedule.",
    why: ACTING_IMMUNIZATION_COPY,
  },
  {
    file: "app/(app)/records/specialty/substance-use/page.tsx",
    substring: "reduction targets you set",
    why: ACTING_SUBSTANCE_USE_COPY,
  },
  {
    file: "app/(app)/records/ImmunizationsSection.tsx",
    substring:
      "Add your date of birth in Settings to see age-based recommendations.",
    why: ACTING_IMMUNIZATION_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "You already have a profile named",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "The people you track. Adding a family member",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "unless you want to give",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "only the profiles you grant them below.",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "you can grant access later under Access.",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "If this is your own",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/settings/family/FamilyManager.tsx",
    substring: "login, you’ll be signed out.",
    why: FAMILY_LOGIN_COPY,
  },
  {
    file: "app/(app)/upcoming/page.tsx",
    substring: "You can view several profiles at once",
    why: VIEW_CONTROL_COPY,
  },
  {
    file: "components/ProfileSwitcherPanel.tsx",
    substring: "Toggle the eye to show a profile in your",
    why: VIEW_CONTROL_COPY,
  },
  {
    file: "components/ProfileSwitcherPanel.tsx",
    substring: "is always in your view",
    why: VIEW_CONTROL_COPY,
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    for (const full of walk(path.join(REPO, d))) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      if (EXCLUDE_SUBPATH.some((p) => rel.startsWith(p))) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  for (const rel of SCAN_FILES) {
    files.push({ rel, text: fs.readFileSync(path.join(REPO, rel), "utf8") });
  }
  return files;
}

function crossProfileSourceFiles(): { rel: string; text: string }[] {
  return sourceFiles().filter(
    ({ rel, text }) =>
      rel.endsWith(".tsx") &&
      (CROSS_PROFILE_FILES.has(rel) ||
        CROSS_PROFILE_PREFIXES.some((prefix) => rel.startsWith(prefix)) ||
        CROSS_PROFILE_MARKERS.some((marker) => marker.test(text)))
  );
}

const NAMED_HTML_WHITESPACE = new Map<string, string>([
  ["Tab", "\t"],
  ["NewLine", "\n"],
  ["nbsp", "\u00a0"],
  ["NonBreakingSpace", "\u00a0"],
  ["ensp", "\u2002"],
  ["emsp", "\u2003"],
  ["emsp13", "\u2004"],
  ["emsp14", "\u2005"],
  ["numsp", "\u2007"],
  ["puncsp", "\u2008"],
  ["thinsp", "\u2009"],
  ["ThinSpace", "\u2009"],
  ["hairsp", "\u200a"],
  ["VeryThinSpace", "\u200a"],
  ["MediumSpace", "\u205f"],
  ["ThickSpace", "\u205f\u200a"],
]);

function decodeHtmlCharacterReference(reference: string): string | null {
  const body = reference.slice(1, -1);
  if (!body.startsWith("#")) return NAMED_HTML_WHITESPACE.get(body) ?? null;

  const hex = body[1] === "x" || body[1] === "X";
  const digits = body.slice(hex ? 2 : 1);
  if (!(hex ? /^[0-9a-f]+$/i : /^\d+$/).test(digits)) return null;
  const codePoint = Number.parseInt(digits, hex ? 16 : 10);
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return null;
  }
}

type ProjectedText = { text: string; origins: number[] };

function decodeJsStringContent(
  raw: string,
  sourceStart: number
): ProjectedText | null {
  const parts: string[] = [];
  const origins: number[] = [];
  const append = (value: string, origin: number) => {
    parts.push(value);
    origins.push(...Array.from({ length: value.length }, () => origin));
  };
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "\\") {
      append(raw[i], sourceStart + i);
      continue;
    }

    const escapeStart = sourceStart + i;
    const next = raw[++i];
    if (next == null) return null;
    if (next === "\n") continue;
    if (next === "\r") {
      if (raw[i + 1] === "\n") i++;
      continue;
    }
    const simple: Record<string, string> = {
      t: "\t",
      n: "\n",
      r: "\r",
      f: "\f",
      v: "\v",
      b: "\b",
      0: "\0",
    };
    if (next in simple) {
      append(simple[next], escapeStart);
      continue;
    }
    if (next === "x") {
      const digits = raw.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/i.test(digits)) return null;
      append(String.fromCodePoint(Number.parseInt(digits, 16)), escapeStart);
      i += 2;
      continue;
    }
    if (next === "u") {
      if (raw[i + 1] === "{") {
        const close = raw.indexOf("}", i + 2);
        if (close === -1) return null;
        const digits = raw.slice(i + 2, close);
        if (!/^[0-9a-f]+$/i.test(digits)) return null;
        try {
          append(
            String.fromCodePoint(Number.parseInt(digits, 16)),
            escapeStart
          );
        } catch {
          return null;
        }
        i = close;
      } else {
        const digits = raw.slice(i + 1, i + 5);
        if (!/^[0-9a-f]{4}$/i.test(digits)) return null;
        append(String.fromCodePoint(Number.parseInt(digits, 16)), escapeStart);
        i += 4;
      }
      continue;
    }
    append(next, escapeStart);
  }
  return { text: parts.join(""), origins };
}

function concatProjected(parts: ProjectedText[]): ProjectedText {
  return {
    text: parts.map((part) => part.text).join(""),
    origins: parts.flatMap((part) => part.origins),
  };
}

type StaticPath = (string | number)[];
type StaticBindingDeclaration =
  ts.VariableDeclaration | ts.ParameterDeclaration;
type StaticReferenceResolver = (
  node: ts.Identifier,
  path: StaticPath,
  seen: ReadonlySet<StaticBindingDeclaration>
) => ProjectedText | null;

function staticReference(
  node: ts.Expression
): { identifier: ts.Identifier; path: StaticPath } | null {
  if (ts.isIdentifier(node)) return { identifier: node, path: [] };
  if (ts.isPropertyAccessExpression(node)) {
    const base = staticReference(node.expression);
    return base
      ? { identifier: base.identifier, path: [...base.path, node.name.text] }
      : null;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const base = staticReference(node.expression);
    const key = node.argumentExpression;
    if (!base || (!ts.isStringLiteral(key) && !ts.isNumericLiteral(key))) {
      return null;
    }
    return {
      identifier: base.identifier,
      path: [
        ...base.path,
        ts.isNumericLiteral(key) ? Number(key.text) : key.text,
      ],
    };
  }
  return null;
}

function staticStringExpression(
  node: ts.Expression,
  file: ts.SourceFile,
  source: string,
  resolveReference: StaticReferenceResolver,
  seen: ReadonlySet<StaticBindingDeclaration> = new Set(),
  rawTemplate = false
): ProjectedText | null {
  const literalContent = (raw: string, start: number): ProjectedText | null =>
    rawTemplate
      ? {
          text: raw,
          origins: Array.from(
            { length: raw.length },
            (_, index) => start + index
          ),
        }
      : decodeJsStringContent(raw, start);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const start = node.getStart(file);
    return literalContent(source.slice(start + 1, node.end - 1), start + 1);
  }
  if (ts.isTemplateExpression(node)) {
    const headStart = node.head.getStart(file);
    const parts: ProjectedText[] = [];
    const head = literalContent(
      source.slice(headStart + 1, node.head.end - 2),
      headStart + 1
    );
    if (!head) return null;
    parts.push(head);
    for (const span of node.templateSpans) {
      const expression = staticStringExpression(
        span.expression,
        file,
        source,
        resolveReference,
        seen
      );
      if (!expression) return null;
      parts.push(expression);
      const literalStart = span.literal.getStart(file);
      const literalEndTrim = ts.isTemplateTail(span.literal) ? 1 : 2;
      const literal = literalContent(
        source.slice(literalStart + 1, span.literal.end - literalEndTrim),
        literalStart + 1
      );
      if (!literal) return null;
      parts.push(literal);
    }
    return concatProjected(parts);
  }
  if (
    ts.isTaggedTemplateExpression(node) &&
    ts.isPropertyAccessExpression(node.tag) &&
    ts.isIdentifier(node.tag.expression) &&
    node.tag.expression.text === "String" &&
    node.tag.name.text === "raw"
  ) {
    return staticStringExpression(
      node.template,
      file,
      source,
      resolveReference,
      seen,
      true
    );
  }
  if (ts.isParenthesizedExpression(node)) {
    return staticStringExpression(
      node.expression,
      file,
      source,
      resolveReference,
      seen,
      rawTemplate
    );
  }
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return staticStringExpression(
      node.expression,
      file,
      source,
      resolveReference,
      seen,
      rawTemplate
    );
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringExpression(
      node.left,
      file,
      source,
      resolveReference,
      seen,
      rawTemplate
    );
    const right = staticStringExpression(
      node.right,
      file,
      source,
      resolveReference,
      seen,
      rawTemplate
    );
    return left && right ? concatProjected([left, right]) : null;
  }
  const reference = staticReference(node);
  if (reference) {
    return resolveReference(reference.identifier, reference.path, seen);
  }
  return null;
}

type LexicalBinding = {
  name: string;
  scope: ts.Node;
  declaration: StaticBindingDeclaration | null;
  path: StaticPath;
  defaults: {
    initializer: ts.Expression;
    path: StaticPath;
    triggerPath: StaticPath;
  }[];
};

// Project syntax that is statically known to become rendered text. HTML character
// references decode in JSX text and user-copy attributes, never JavaScript strings
// or metadata attributes. JSX expressions resolve only lexical const bindings they
// actually render, transitively and with a cycle guard. Every projected character
// retains an original offset so diagnostics keep exact lines after projection.
function projectStaticRenderedCopy(source: string): ProjectedText[] {
  const file = ts.createSourceFile(
    "copy-lint.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const bindings: LexicalBinding[] = [];

  const enclosingScope = (node: ts.Node): ts.Node => {
    for (let current = node.parent; current; current = current.parent) {
      if (
        ts.isSourceFile(current) ||
        ts.isBlock(current) ||
        ts.isModuleBlock(current) ||
        ts.isCaseBlock(current) ||
        ts.isCatchClause(current) ||
        ts.isForStatement(current) ||
        ts.isForInStatement(current) ||
        ts.isForOfStatement(current) ||
        ts.isFunctionLike(current)
      ) {
        return current;
      }
    }
    return file;
  };
  const enclosingVarScope = (node: ts.Node): ts.Node => {
    for (let current = node.parent; current; current = current.parent) {
      if (ts.isSourceFile(current) || ts.isFunctionLike(current))
        return current;
    }
    return file;
  };
  const propertyKey = (name: ts.PropertyName): string | number | null => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
    if (ts.isNumericLiteral(name)) return Number(name.text);
    return null;
  };
  const bindingEntries = (
    name: ts.BindingName,
    path: StaticPath = [],
    defaults: { initializer: ts.Expression; depth: number }[] = []
  ): {
    name: string;
    path: StaticPath;
    defaults: {
      initializer: ts.Expression;
      path: StaticPath;
      triggerPath: StaticPath;
    }[];
  }[] => {
    if (ts.isIdentifier(name)) {
      return [
        {
          name: name.text,
          path,
          defaults: defaults.map((fallback) => ({
            initializer: fallback.initializer,
            path: path.slice(fallback.depth),
            triggerPath: path.slice(0, fallback.depth),
          })),
        },
      ];
    }
    if (ts.isObjectBindingPattern(name)) {
      return name.elements.flatMap((element) => {
        if (element.dotDotDotToken) return [];
        const key = element.propertyName
          ? propertyKey(element.propertyName)
          : ts.isIdentifier(element.name)
            ? element.name.text
            : null;
        const nextPath = key == null ? path : [...path, key];
        return key == null
          ? []
          : bindingEntries(
              element.name,
              nextPath,
              element.initializer
                ? [
                    ...defaults,
                    {
                      initializer: element.initializer,
                      depth: nextPath.length,
                    },
                  ]
                : defaults
            );
      });
    }
    return name.elements.flatMap((element, index) =>
      ts.isOmittedExpression(element)
        ? []
        : (() => {
            const nextPath = [...path, index];
            return bindingEntries(
              element.name,
              nextPath,
              element.initializer
                ? [
                    ...defaults,
                    {
                      initializer: element.initializer,
                      depth: nextPath.length,
                    },
                  ]
                : defaults
            );
          })()
    );
  };
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const declarationList = ts.isVariableDeclarationList(node.parent)
        ? node.parent
        : null;
      const eligible =
        declarationList &&
        (declarationList.flags & ts.NodeFlags.Const) !== 0 &&
        node.initializer
          ? node
          : null;
      const blockScoped =
        declarationList &&
        (declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0;
      const scope = ts.isCatchClause(node.parent)
        ? node.parent
        : blockScoped
          ? enclosingScope(node)
          : enclosingVarScope(node);
      for (const binding of bindingEntries(node.name)) {
        bindings.push({
          ...binding,
          scope,
          declaration: eligible,
        });
      }
    } else if (ts.isParameter(node)) {
      for (const binding of bindingEntries(node.name)) {
        bindings.push({
          ...binding,
          scope: node.parent,
          declaration: node,
        });
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(file);

  const staticExpressionAtPath = (
    expression: ts.Expression,
    path: StaticPath,
    seen: ReadonlySet<StaticBindingDeclaration>
  ): ProjectedText | null => {
    if (path.length === 0) {
      return staticStringExpression(
        expression,
        file,
        source,
        resolveReference,
        seen
      );
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      return staticExpressionAtPath(expression.expression, path, seen);
    }
    const [head, ...tail] = path;
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          propertyKey(property.name) === head
        ) {
          return staticExpressionAtPath(property.initializer, tail, seen);
        }
        if (
          ts.isShorthandPropertyAssignment(property) &&
          property.name.text === head
        ) {
          return resolveReference(property.name, tail, seen);
        }
      }
      return null;
    }
    if (ts.isArrayLiteralExpression(expression) && typeof head === "number") {
      const element = expression.elements[head];
      return element && !ts.isSpreadElement(element)
        ? staticExpressionAtPath(element, tail, seen)
        : null;
    }
    const reference = staticReference(expression);
    return reference
      ? resolveReference(
          reference.identifier,
          [...reference.path, ...path],
          seen
        )
      : null;
  };

  function staticPathExists(
    expression: ts.Expression,
    path: StaticPath,
    seen: ReadonlySet<StaticBindingDeclaration>
  ): boolean | null {
    if (path.length === 0) return true;
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      return staticPathExists(expression.expression, path, seen);
    }
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = staticPathExists(expression.whenTrue, path, seen);
      const whenFalse = staticPathExists(expression.whenFalse, path, seen);
      return whenTrue === whenFalse ? whenTrue : null;
    }
    const [head, ...tail] = path;
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          propertyKey(property.name) === head
        ) {
          return staticPathExists(property.initializer, tail, seen);
        }
        if (
          ts.isShorthandPropertyAssignment(property) &&
          property.name.text === head
        ) {
          const binding = lexicalBinding(property.name);
          const declaration = binding?.declaration;
          return declaration?.initializer && !seen.has(declaration)
            ? staticPathExists(
                declaration.initializer,
                [...(binding?.path ?? []), ...tail],
                new Set(seen).add(declaration)
              )
            : null;
        }
      }
      return false;
    }
    if (ts.isArrayLiteralExpression(expression) && typeof head === "number") {
      const element = expression.elements[head];
      return element && !ts.isOmittedExpression(element)
        ? staticPathExists(element, tail, seen)
        : false;
    }
    const reference = staticReference(expression);
    if (!reference) return null;
    const binding = lexicalBinding(reference.identifier);
    const declaration = binding?.declaration;
    return declaration?.initializer && !seen.has(declaration)
      ? staticPathExists(
          declaration.initializer,
          [...(binding?.path ?? []), ...reference.path, ...path],
          new Set(seen).add(declaration)
        )
      : null;
  }

  const lexicalBinding = (identifier: ts.Identifier): LexicalBinding | null => {
    const offset = identifier.getStart(file);
    const candidates = bindings.filter(
      (binding) =>
        binding.name === identifier.text &&
        binding.scope.getStart(file) <= offset &&
        offset < binding.scope.end
    );
    if (candidates.length === 0) return null;
    const nearestSize = Math.min(
      ...candidates.map(
        (binding) => binding.scope.end - binding.scope.getStart(file)
      )
    );
    const nearest = candidates.filter(
      (binding) =>
        binding.scope.end - binding.scope.getStart(file) === nearestSize
    );
    return nearest.length === 1 ? nearest[0] : null;
  };

  const resolveReference: StaticReferenceResolver = (
    identifier: ts.Identifier,
    path: StaticPath,
    seen: ReadonlySet<StaticBindingDeclaration>
  ) => {
    const binding = lexicalBinding(identifier);
    if (!binding) return null;
    const declaration = binding.declaration;
    if (!declaration || seen.has(declaration)) return null;
    const nextSeen = new Set(seen).add(declaration);
    const resolved = declaration.initializer
      ? staticExpressionAtPath(
          declaration.initializer,
          [...binding.path, ...path],
          nextSeen
        )
      : null;
    if (resolved) return resolved;
    let activeExpression = declaration.initializer;
    let activeBasePath: StaticPath = [];
    for (const fallback of binding.defaults) {
      const triggerPath = fallback.triggerPath.slice(activeBasePath.length);
      if (
        activeExpression &&
        staticPathExists(activeExpression, triggerPath, nextSeen) === true
      ) {
        continue;
      }
      activeExpression = fallback.initializer;
      activeBasePath = fallback.triggerPath;
      const candidate = staticExpressionAtPath(
        fallback.initializer,
        [...fallback.path, ...path],
        nextSeen
      );
      if (candidate) return candidate;
    }
    return null;
  };

  const sourceProjection = (start: number, end: number): ProjectedText => ({
    text: source.slice(start, end),
    origins: Array.from({ length: end - start }, (_, index) => start + index),
  });
  const htmlTextProjection = (start: number, end: number): ProjectedText => {
    const raw = source.slice(start, end);
    const references = /&(?:#(?:[xX][0-9a-fA-F]+|\d+)|[A-Za-z][A-Za-z0-9]+);/g;
    const parts: ProjectedText[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = references.exec(raw)) !== null) {
      const decoded = decodeHtmlCharacterReference(match[0]);
      if (decoded == null) continue;
      parts.push(sourceProjection(start + cursor, start + match.index));
      parts.push({
        text: decoded!,
        origins: Array.from(
          { length: decoded!.length },
          () => start + match!.index
        ),
      });
      cursor = match.index + match[0].length;
    }
    parts.push(sourceProjection(start + cursor, end));
    return concatProjected(parts);
  };

  const uniqueVariants = (variants: ProjectedText[]): ProjectedText[] => {
    const seen = new Set<string>();
    return variants.filter((variant) => {
      if (seen.has(variant.text)) return false;
      seen.add(variant.text);
      return true;
    });
  };
  function staticVariantsAtPath(
    expression: ts.Expression,
    path: StaticPath,
    seen: ReadonlySet<StaticBindingDeclaration>
  ): ProjectedText[] {
    const single = staticExpressionAtPath(expression, path, seen);
    if (single) return [single];
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      return staticVariantsAtPath(expression.expression, path, seen);
    }
    if (ts.isConditionalExpression(expression)) {
      return uniqueVariants([
        ...staticVariantsAtPath(expression.whenTrue, path, seen),
        ...staticVariantsAtPath(expression.whenFalse, path, seen),
      ]);
    }
    if (ts.isBinaryExpression(expression)) {
      if (
        expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return uniqueVariants([
          empty,
          ...staticVariantsAtPath(expression.right, path, seen),
        ]);
      }
      if (
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return uniqueVariants([
          ...staticVariantsAtPath(expression.left, path, seen),
          ...staticVariantsAtPath(expression.right, path, seen),
        ]);
      }
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return staticVariantsAtPath(
        expression.expression,
        [expression.name.text, ...path],
        seen
      );
    }
    if (
      ts.isElementAccessExpression(expression) &&
      expression.argumentExpression &&
      (ts.isStringLiteral(expression.argumentExpression) ||
        ts.isNumericLiteral(expression.argumentExpression))
    ) {
      const key = ts.isNumericLiteral(expression.argumentExpression)
        ? Number(expression.argumentExpression.text)
        : expression.argumentExpression.text;
      return staticVariantsAtPath(expression.expression, [key, ...path], seen);
    }
    if (path.length > 0) {
      const [head, ...tail] = path;
      if (ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            propertyKey(property.name) === head
          ) {
            return staticVariantsAtPath(property.initializer, tail, seen);
          }
          if (
            ts.isShorthandPropertyAssignment(property) &&
            property.name.text === head
          ) {
            return resolveReferenceVariants(property.name, tail, seen);
          }
        }
        return [];
      }
      if (ts.isArrayLiteralExpression(expression) && typeof head === "number") {
        const element = expression.elements[head];
        return element && !ts.isSpreadElement(element)
          ? staticVariantsAtPath(element, tail, seen)
          : [];
      }
      const reference = staticReference(expression);
      return reference
        ? resolveReferenceVariants(
            reference.identifier,
            [...reference.path, ...path],
            seen
          )
        : [];
    }
    const reference = staticReference(expression);
    return reference
      ? resolveReferenceVariants(reference.identifier, reference.path, seen)
      : [];
  }
  function resolveReferenceVariants(
    identifier: ts.Identifier,
    path: StaticPath,
    seen: ReadonlySet<StaticBindingDeclaration>
  ): ProjectedText[] {
    const binding = lexicalBinding(identifier);
    const declaration = binding?.declaration;
    if (!binding || !declaration || seen.has(declaration)) return [];
    const nextSeen = new Set(seen).add(declaration);
    const variants = declaration.initializer
      ? staticVariantsAtPath(
          declaration.initializer,
          [...binding.path, ...path],
          nextSeen
        )
      : [];
    if (variants.length > 0) return variants;
    let activeExpression = declaration.initializer;
    let activeBasePath: StaticPath = [];
    for (const fallback of binding.defaults) {
      const triggerPath = fallback.triggerPath.slice(activeBasePath.length);
      if (
        activeExpression &&
        staticPathExists(activeExpression, triggerPath, nextSeen) === true
      ) {
        continue;
      }
      activeExpression = fallback.initializer;
      activeBasePath = fallback.triggerPath;
      const candidates = staticVariantsAtPath(
        fallback.initializer,
        [...fallback.path, ...path],
        nextSeen
      );
      if (candidates.length > 0) return candidates;
    }
    return [];
  }
  const combineVariants = (
    left: ProjectedText[],
    right: ProjectedText[]
  ): ProjectedText[] =>
    uniqueVariants(
      left.flatMap((leftPart) =>
        right.map((rightPart) => concatProjected([leftPart, rightPart]))
      )
    ).slice(0, 128);

  const empty: ProjectedText = { text: "", origins: [] };
  const attributeCandidates: ProjectedText[] = [];
  const USER_COPY_ATTRIBUTES = new Set([
    "alt",
    "aria-description",
    "aria-label",
    "aria-valuetext",
    "children",
    "description",
    "emptyText",
    "label",
    "message",
    "placeholder",
    "subtitle",
    "title",
    "value",
  ]);
  const TECHNICAL_CUSTOM_PROPS = new Set([
    "className",
    "href",
    "id",
    "key",
    "name",
    "role",
    "src",
    "type",
  ]);
  const isCopyProp = (name: string, customComponent: boolean): boolean =>
    USER_COPY_ATTRIBUTES.has(name) ||
    (customComponent &&
      !name.startsWith("data-") &&
      !/^on[A-Z]/.test(name) &&
      !TECHNICAL_CUSTOM_PROPS.has(name));
  const collectSpreadCopyCandidates = (
    expression: ts.Expression,
    customComponent: boolean,
    seen: ReadonlySet<StaticBindingDeclaration> = new Set()
  ): void => {
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          collectSpreadCopyCandidates(
            property.expression,
            customComponent,
            seen
          );
          continue;
        }
        if (
          (ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)) &&
          isCopyProp(
            propertyKey(property.name)?.toString() ?? "",
            customComponent
          )
        ) {
          const value = ts.isPropertyAssignment(property)
            ? property.initializer
            : property.name;
          attributeCandidates.push(...expressionVariants(value));
        }
      }
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      collectSpreadCopyCandidates(expression.whenTrue, customComponent, seen);
      collectSpreadCopyCandidates(expression.whenFalse, customComponent, seen);
      return;
    }
    const reference = staticReference(expression);
    if (!reference || reference.path.length > 0) return;
    const binding = lexicalBinding(reference.identifier);
    const declaration = binding?.declaration;
    if (!declaration?.initializer || seen.has(declaration)) return;
    collectSpreadCopyCandidates(
      declaration.initializer,
      customComponent,
      new Set(seen).add(declaration)
    );
  };
  const collectAttributeCandidates = (
    attributes: ts.JsxAttributes,
    customComponent: boolean
  ): void => {
    for (const property of attributes.properties) {
      if (ts.isJsxSpreadAttribute(property)) {
        collectSpreadCopyCandidates(property.expression, customComponent);
        continue;
      }
      if (!property.initializer) continue;
      const name = property.name.getText(file);
      if (!isCopyProp(name, customComponent)) continue;
      if (ts.isStringLiteral(property.initializer)) {
        const start = property.initializer.getStart(file) + 1;
        attributeCandidates.push(
          htmlTextProjection(start, property.initializer.end - 1)
        );
      } else if (
        ts.isJsxExpression(property.initializer) &&
        property.initializer.expression
      ) {
        attributeCandidates.push(
          ...expressionVariants(property.initializer.expression)
        );
      }
    }
  };

  const renderChildren = (
    children: ts.NodeArray<ts.JsxChild>
  ): ProjectedText[] => {
    let variants = [empty];
    for (const child of children) {
      variants = combineVariants(variants, renderChild(child));
    }
    return variants;
  };
  const renderElement = (
    node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
    root: boolean
  ): ProjectedText[] => {
    if (ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(file);
      collectAttributeCandidates(node.attributes, /^[A-Z]/.test(tag));
      if (ts.isIdentifier(node.tagName)) {
        const component = resolveFunction(node.tagName);
        if (component) return functionRenderedVariants(component);
      }
      return [empty];
    }
    if (ts.isJsxFragment(node)) return renderChildren(node.children);

    const tag = node.openingElement.tagName.getText(file);
    collectAttributeCandidates(
      node.openingElement.attributes,
      /^[A-Z]/.test(tag)
    );
    if (ts.isIdentifier(node.openingElement.tagName)) {
      const component = resolveFunction(node.openingElement.tagName);
      if (component) {
        const variants = functionRenderedVariants(component);
        if (variants.length > 0) return variants;
      }
    }
    const children = renderChildren(node.children);
    if (!root) return children;
    const start = node.openingElement.getStart(file);
    const opening = {
      text: `<${tag}>`,
      origins: Array.from({ length: tag.length + 2 }, () => start),
    };
    const closingStart = node.closingElement.getStart(file);
    const closing = {
      text: `</${tag}>`,
      origins: Array.from({ length: tag.length + 3 }, () => closingStart),
    };
    return children.map((child) => concatProjected([opening, child, closing]));
  };
  const renderChild = (node: ts.JsxChild): ProjectedText[] => {
    if (ts.isJsxText(node)) {
      return [htmlTextProjection(node.getStart(file), node.end)];
    }
    if (ts.isJsxExpression(node)) {
      return node.expression ? expressionVariants(node.expression) : [empty];
    }
    return renderElement(node, false);
  };
  const expressionVariants = (node: ts.Expression): ProjectedText[] => {
    const jsxVariants = jsxNodesAtPath(node, [], new Set()).flatMap((jsx) =>
      renderElement(jsx, false)
    );
    if (jsxVariants.length > 0) return jsxVariants;
    const staticVariants = staticVariantsAtPath(node, [], new Set());
    if (staticVariants.length > 0) return staticVariants;
    if (ts.isParenthesizedExpression(node)) {
      return expressionVariants(node.expression);
    }
    if (ts.isConditionalExpression(node)) {
      return uniqueVariants([
        ...expressionVariants(node.whenTrue),
        ...expressionVariants(node.whenFalse),
      ]);
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        return uniqueVariants([empty, ...expressionVariants(node.right)]);
      }
      if (
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return uniqueVariants([
          ...expressionVariants(node.left),
          ...expressionVariants(node.right),
        ]);
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      let variants = [empty];
      for (const element of node.elements) {
        if (ts.isSpreadElement(element)) continue;
        variants = combineVariants(variants, expressionVariants(element));
      }
      return variants;
    }
    if (ts.isCallExpression(node)) {
      const variants = renderedCallVariants(node);
      if (variants.length > 0) return variants;
    }
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    ) {
      return renderElement(node, false);
    }
    const reference = staticReference(node);
    if (reference && reference.path.length === 0) {
      const initializer = lexicalBinding(reference.identifier)?.declaration
        ?.initializer;
      if (
        initializer &&
        (ts.isJsxElement(initializer) ||
          ts.isJsxSelfClosingElement(initializer) ||
          ts.isJsxFragment(initializer))
      ) {
        return renderElement(initializer, false);
      }
    }
    return [empty];
  };

  function jsxNodesAtPath(
    expression: ts.Expression,
    path: StaticPath,
    seen: ReadonlySet<StaticBindingDeclaration>
  ): (ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment)[] {
    if (
      path.length === 0 &&
      (ts.isJsxElement(expression) ||
        ts.isJsxSelfClosingElement(expression) ||
        ts.isJsxFragment(expression))
    ) {
      return [expression];
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      return jsxNodesAtPath(expression.expression, path, seen);
    }
    if (ts.isConditionalExpression(expression)) {
      return [
        ...jsxNodesAtPath(expression.whenTrue, path, seen),
        ...jsxNodesAtPath(expression.whenFalse, path, seen),
      ];
    }
    if (ts.isBinaryExpression(expression)) {
      if (
        expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        return jsxNodesAtPath(expression.right, path, seen);
      }
      if (
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        return [
          ...jsxNodesAtPath(expression.left, path, seen),
          ...jsxNodesAtPath(expression.right, path, seen),
        ];
      }
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return jsxNodesAtPath(
        expression.expression,
        [expression.name.text, ...path],
        seen
      );
    }
    if (
      ts.isElementAccessExpression(expression) &&
      expression.argumentExpression &&
      (ts.isStringLiteral(expression.argumentExpression) ||
        ts.isNumericLiteral(expression.argumentExpression))
    ) {
      const key = ts.isNumericLiteral(expression.argumentExpression)
        ? Number(expression.argumentExpression.text)
        : expression.argumentExpression.text;
      return jsxNodesAtPath(expression.expression, [key, ...path], seen);
    }
    if (path.length > 0) {
      const [head, ...tail] = path;
      if (ts.isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
          if (
            ts.isPropertyAssignment(property) &&
            propertyKey(property.name) === head
          ) {
            return jsxNodesAtPath(property.initializer, tail, seen);
          }
          if (
            ts.isShorthandPropertyAssignment(property) &&
            property.name.text === head
          ) {
            return jsxNodesAtPath(property.name, tail, seen);
          }
        }
        return [];
      }
      if (ts.isArrayLiteralExpression(expression) && typeof head === "number") {
        const element = expression.elements[head];
        return element && !ts.isSpreadElement(element)
          ? jsxNodesAtPath(element, tail, seen)
          : [];
      }
    }
    const reference = staticReference(expression);
    if (!reference) return [];
    const binding = lexicalBinding(reference.identifier);
    const declaration = binding?.declaration;
    if (!binding || !declaration || seen.has(declaration)) return [];
    const nextSeen = new Set(seen).add(declaration);
    const requestedPath = [...binding.path, ...reference.path, ...path];
    const primary = declaration.initializer
      ? jsxNodesAtPath(declaration.initializer, requestedPath, nextSeen)
      : [];
    if (primary.length > 0) return primary;
    let activeExpression = declaration.initializer;
    let activeBasePath: StaticPath = [];
    for (const fallback of binding.defaults) {
      const triggerPath = fallback.triggerPath.slice(activeBasePath.length);
      if (
        activeExpression &&
        staticPathExists(activeExpression, triggerPath, nextSeen) === true
      ) {
        continue;
      }
      activeExpression = fallback.initializer;
      activeBasePath = fallback.triggerPath;
      const candidates = jsxNodesAtPath(
        fallback.initializer,
        [...fallback.path, ...reference.path, ...path],
        nextSeen
      );
      if (candidates.length > 0) return candidates;
    }
    return [];
  }

  const activeRenderCalls = new Set<ts.FunctionLikeDeclaration>();
  function functionRenderedVariants(
    node: ts.FunctionLikeDeclaration
  ): ProjectedText[] {
    if (!node.body || activeRenderCalls.has(node)) return [];
    activeRenderCalls.add(node);
    try {
      if (!ts.isBlock(node.body)) return expressionVariants(node.body);
      const variants: ProjectedText[] = [];
      const visitReturns = (child: ts.Node): void => {
        if (child !== node.body && ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child) && child.expression) {
          variants.push(...expressionVariants(child.expression));
          return;
        }
        ts.forEachChild(child, visitReturns);
      };
      visitReturns(node.body);
      return uniqueVariants(variants);
    } finally {
      activeRenderCalls.delete(node);
    }
  }

  function renderedCallVariants(node: ts.CallExpression): ProjectedText[] {
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "map" ||
        node.expression.name.text === "flatMap")
    ) {
      const callback = node.arguments[0];
      if (!callback) return [];
      if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
        return functionRenderedVariants(callback);
      }
      return ts.isIdentifier(callback)
        ? (() => {
            const resolved = resolveFunction(callback);
            return resolved ? functionRenderedVariants(resolved) : [];
          })()
        : [];
    }
    if (!ts.isIdentifier(node.expression)) return [];
    const resolved = resolveFunction(node.expression);
    return resolved ? functionRenderedVariants(resolved) : [];
  }

  const renderedRoots: ProjectedText[] = [];
  const reachableJsx = new Set<
    ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment
  >();
  const followedFlow = new Set<ts.Node>();
  const functionDeclarations: {
    name: string;
    scope: ts.Node;
    declaration: ts.FunctionDeclaration;
  }[] = [];
  const collectFunctions = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      functionDeclarations.push({
        name: node.name.text,
        scope: enclosingScope(node),
        declaration: node,
      });
    }
    ts.forEachChild(node, collectFunctions);
  };
  collectFunctions(file);

  const resolveFunction = (
    identifier: ts.Identifier
  ): ts.FunctionLikeDeclaration | null => {
    const variableBinding = lexicalBinding(identifier);
    if (variableBinding) {
      const initializer = variableBinding.declaration?.initializer;
      return initializer &&
        (ts.isArrowFunction(initializer) ||
          ts.isFunctionExpression(initializer))
        ? initializer
        : null;
    }
    const offset = identifier.getStart(file);
    const candidates = functionDeclarations.filter(
      (binding) =>
        binding.name === identifier.text &&
        binding.scope.getStart(file) <= offset &&
        offset < binding.scope.end
    );
    if (candidates.length === 0) return null;
    const nearestSize = Math.min(
      ...candidates.map(
        (binding) => binding.scope.end - binding.scope.getStart(file)
      )
    );
    const nearest = candidates.filter(
      (binding) =>
        binding.scope.end - binding.scope.getStart(file) === nearestSize
    );
    return nearest.length === 1 ? nearest[0].declaration : null;
  };

  const isFunctionImplementation = (
    node: ts.Node
  ): node is ts.FunctionLikeDeclaration =>
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node);
  const hasExportModifier = (node: ts.Node): boolean =>
    !!ts
      .getModifiers(node as ts.HasModifiers)
      ?.some(
        (modifier) =>
          modifier.kind === ts.SyntaxKind.ExportKeyword ||
          modifier.kind === ts.SyntaxKind.DefaultKeyword
      );
  const isComponentFunction = (node: ts.FunctionLikeDeclaration): boolean => {
    const variableStatement =
      ts.isVariableDeclaration(node.parent) &&
      ts.isVariableDeclarationList(node.parent.parent) &&
      ts.isVariableStatement(node.parent.parent.parent)
        ? node.parent.parent.parent
        : null;
    return (
      hasExportModifier(node) ||
      (!!variableStatement && hasExportModifier(variableStatement))
    );
  };
  const markFunction = (node: ts.FunctionLikeDeclaration): void => {
    if (followedFlow.has(node)) return;
    followedFlow.add(node);
    if (!node.body) return;
    if (!ts.isBlock(node.body)) {
      markExpression(node.body);
      return;
    }
    const visitReturns = (child: ts.Node): void => {
      if (child !== node.body && ts.isFunctionLike(child)) return;
      if (ts.isReturnStatement(child) && child.expression) {
        markExpression(child.expression);
        return;
      }
      ts.forEachChild(child, visitReturns);
    };
    visitReturns(node.body);
  };
  const markExpression = (node: ts.Expression): void => {
    if (followedFlow.has(node)) return;
    followedFlow.add(node);
    const referencedJsx = jsxNodesAtPath(node, [], new Set());
    if (referencedJsx.length > 0) {
      for (const jsx of referencedJsx) reachableJsx.add(jsx);
      return;
    }
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      markExpression(node.expression);
      return;
    }
    if (ts.isConditionalExpression(node)) {
      markExpression(node.whenTrue);
      markExpression(node.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      markExpression(node.left);
      markExpression(node.right);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (!ts.isSpreadElement(element)) markExpression(element);
      }
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const resolved = resolveFunction(node.expression);
      if (resolved) markFunction(resolved);
      return;
    }
  };
  const seedFlow = (node: ts.Node): void => {
    if (isFunctionImplementation(node) && isComponentFunction(node)) {
      markFunction(node);
      return;
    }
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      ts.isSourceFile(node.parent)
    ) {
      markExpression(node.expression);
      return;
    }
    const containsJsx = (candidate: ts.Node): boolean => {
      if (
        ts.isJsxElement(candidate) ||
        ts.isJsxSelfClosingElement(candidate) ||
        ts.isJsxFragment(candidate)
      ) {
        return true;
      }
      if (ts.isFunctionLike(candidate)) return false;
      let found = false;
      ts.forEachChild(candidate, (child) => {
        if (!found && containsJsx(child)) found = true;
      });
      return found;
    };
    if (ts.isExpressionStatement(node) && containsJsx(node.expression)) {
      markExpression(node.expression);
      return;
    }
    ts.forEachChild(node, seedFlow);
  };
  seedFlow(file);
  for (const node of reachableJsx) {
    renderedRoots.push(...renderElement(node, true));
  }
  return [...renderedRoots, ...attributeCandidates];
}

// A line is a non-user-facing context (internal logging / thrown error / import) —
// its strings are for developers or masked before a user sees them, so the ban
// doesn't apply.
function isInternalLine(line: string): boolean {
  return (
    /\bconsole\.\w+\s*\(/.test(line) ||
    /\blog\.(error|warn|info|debug|trace)\s*\(/.test(line) ||
    /\bthrow new \w*Error\s*\(/.test(line) ||
    /^\s*import\s/.test(line) ||
    /^\s*export\s.*\bfrom\s/.test(line)
  );
}

function allowed(rel: string, snippet: string): boolean {
  return ALLOW.some((a) => a.file === rel && snippet.includes(a.substring));
}

const SECOND_PERSON = /\b(?:you|your)\b/i;

function voiceAllowed(rel: string, snippet: string): boolean {
  return CROSS_PROFILE_VOICE_ALLOW.some(
    (a) => a.file === rel && snippet.includes(a.substring)
  );
}

function crossProfileVoiceViolations(rel: string, text: string): string[] {
  const violations: string[] = [];
  const code = stripComments(text);
  code.split("\n").forEach((line, i) => {
    if (isInternalLine(line)) return;
    if (SECOND_PERSON.test(line) && !voiceAllowed(rel, line)) {
      violations.push(
        `${rel}:${i + 1} — second-person copy in: ${line.trim()}`
      );
    }
  });
  return violations;
}

function disclaimerCopyViolations(rel: string, text: string): string[] {
  if (DISCLAIMER_COPY_ALLOW.has(rel)) return [];

  const projections = projectStaticRenderedCopy(text);
  const violations = new Set<string>();
  for (const projection of projections) {
    for (const phrasing of DISCLAIMER_PHRASINGS) {
      const flags = `${phrasing.flags.replace(/g/g, "")}g`;
      const matcher = new RegExp(phrasing.source, flags);
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(projection.text)) !== null) {
        const sourceOffset = projection.origins[match.index] ?? 0;
        const line = text.slice(0, sourceOffset).split("\n").length;
        const lineStart =
          projection.text.lastIndexOf("\n", match.index - 1) + 1;
        const lineEnd = projection.text.indexOf(
          "\n",
          match.index + match[0].length
        );
        const snippet = projection.text
          .slice(lineStart, lineEnd === -1 ? projection.text.length : lineEnd)
          .replace(/\s+/g, " ")
          .trim();
        violations.add(`${rel}:${line} — disclaimer prose in: ${snippet}`);
      }
    }
  }
  return [...violations];
}

describe("copy-lint: user-facing tone standard (issue #945)", () => {
  it("no banned error-verb phrasing or 'please' in user-facing copy", () => {
    const violations: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      const code = stripComments(text);
      code.split("\n").forEach((line, i) => {
        if (isInternalLine(line)) return;
        for (const { re, label } of BANNED) {
          if (re.test(line) && !allowed(rel, line)) {
            violations.push(`${rel}:${i + 1} — ${label} in: ${line.trim()}`);
          }
        }
      });
    }
    expect(
      violations,
      `User-facing copy must follow docs/internals/copy.md. Rewrite to the ` +
        `standard error shape ("Couldn't <verb> <object>." + "Try again." only ` +
        `on transient failures) and drop "please". A legitimate exception goes on ` +
        `the frozen ALLOW list in this test with a justification:\n` +
        violations.join("\n")
    ).toEqual([]);
  });

  it('every "Couldn\'t …" error string ends with terminal punctuation', () => {
    const violations: string[] = [];
    for (const { rel, text } of sourceFiles()) {
      const code = stripComments(text);
      code.split("\n").forEach((line, i) => {
        // Label/tooltip fragments legitimately omit the period (rule 3); the
        // aria-label / title="…" attribute is the one place a "Couldn't save"
        // fragment is correct.
        if (/\b(aria-label|title)\s*=/.test(line)) return;
        let m: RegExpExecArray | null;
        COULDNT_LITERAL.lastIndex = 0;
        while ((m = COULDNT_LITERAL.exec(line)) !== null) {
          const content = m[2].trim();
          if (!TERMINAL.test(content)) {
            violations.push(
              `${rel}:${i + 1} — "${content}" (missing terminal period)`
            );
          }
        }
      });
    }
    expect(
      violations,
      `A complete-sentence error string ends with a period (rule 3). Add the ` +
        `terminal period, or if this is a label/chip fragment move it into an ` +
        `aria-label/title attribute:\n` +
        violations.join("\n")
    ).toEqual([]);
  });

  it('cross-profile surfaces do not render "you" or "your" health-data copy', () => {
    const violations = crossProfileSourceFiles().flatMap(({ rel, text }) =>
      crossProfileVoiceViolations(rel, text)
    );
    expect(
      violations,
      `Cross-profile copy must name the profile or use neutral phrasing; "you" / ` +
        `"your" means the active profile. Login-scoped control copy may enter the ` +
        `frozen CROSS_PROFILE_VOICE_ALLOW list with an exact substring and reason:\n` +
        violations.join("\n")
    ).toEqual([]);
  });

  it("domain surfaces do not render disclaimer prose", () => {
    const violations = sourceFiles().flatMap(({ rel, text }) =>
      disclaimerCopyViolations(rel, text)
    );
    expect(
      violations,
      `Disclaimer posture belongs in lib/disclaimers.ts and renders only on ` +
        `/disclaimer. Replace inline prose with at most a one-line canonical link; ` +
        `do not add a domain-surface allowlist entry:\n${violations.join("\n")}`
    ).toEqual([]);
  });

  it("the disclaimer scan detects every phrase family, including across JSX lines, and ignores comments", () => {
    const sample = [
      "// This is not medical advice.",
      "{/* Informational only. Consult a clinician. */}",
      "<p>This is not medical advice.</p>",
      "<p>Informational",
      "only.</p>",
      "<p>Consult a clinician.</p>",
      "<p>Informational, never prescriptive.</p>",
      "<p>This reading is not a diagnosis.</p>",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toHaveLength(5);
  });

  it("reports the original source line after a multiline block comment", () => {
    const sample = [
      "/*",
      " * disclaimer design note",
      " * Consult a clinician.",
      " */",
      "const one = 1;",
      "const two = 2;",
      "const three = 3;",
      "<p>Informational",
      "only.</p>",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:8 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("does not mistake a MIME glob for the start of a block comment", () => {
    const sample = [
      'const accept = "image/*";',
      "<p>Consult a clinician.</p>",
      "{/* a real JSX comment */}",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:2 — disclaimer prose in: <p>Consult a clinician.</p>",
    ]);
  });

  it("detects disclaimer prose split by a JSX whitespace expression", () => {
    const sample = '<p>Informational{" "}only.</p>';
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("detects disclaimer prose assembled by a static JSX template expression", () => {
    const sample = '<p>{`Informational${" "}only.`}</p>';
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("detects a static const template later rendered through an identifier", () => {
    const sample = [
      'const disclaimer = `Informational${" "}only.`;',
      "return <p>{disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("resolves rendered const templates transitively without projecting unrendered constants", () => {
    const rendered = [
      'const spacing = " ";',
      "const disclaimer = `Informational${spacing}only.`;",
      "return <p>{disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", rendered)).toEqual([
      "synthetic.tsx:2 — disclaimer prose in: <p>Informational only.</p>",
    ]);

    const internal = [
      'const spacing = " ";',
      "const disclaimer = `Informational${spacing}only.`;",
      "console.debug(disclaimer);",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", internal)).toEqual([]);
  });

  it("does not project an unrendered direct const string", () => {
    const sample = [
      'const diagnostic = "Informational only.";',
      "console.debug(diagnostic);",
      "return <p>Status</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([]);
  });

  it("uses function scope for var bindings that shadow an outer const", () => {
    const sample = [
      'const spacing = " ";',
      "const diagnostic = `Informational${spacing}only.`;",
      "function Status() {",
      "  {",
      '    var diagnostic = "safe";',
      "  }",
      "  return <p>{diagnostic}</p>;",
      "}",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([]);
  });

  it("projects a const from a conditionally rendered JSX branch", () => {
    const sample = [
      'const spacing = " ";',
      "const disclaimer = `Informational${spacing}only.`;",
      "return <p>{show && disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:2 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("branches conditional and logical const initializers when rendered", () => {
    const conditional = [
      'const disclaimer = show ? "Informational only." : "Status";',
      "return <p>{disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", conditional)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);

    const logical = [
      'const disclaimer = show && "Consult a clinician.";',
      "return <p>{disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", logical)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Consult a clinician.</p>",
    ]);
  });

  it("preserves property paths through conditional and logical aliases", () => {
    const conditional = [
      'const notice = show ? { copy: "Informational only." } : {};',
      "return <p>{notice.copy}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", conditional)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);

    const logical = [
      'const notice = show && { copy: "Consult a clinician." };',
      "return <p>{notice.copy}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", logical)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Consult a clinician.</p>",
    ]);
  });

  it("resolves a rendered destructuring default", () => {
    const sample = [
      'const { copy = "Informational only." } = {};',
      "return <p>{copy}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("resolves parameter and nested destructuring defaults", () => {
    const parameter = [
      'export function Card({ copy = "Informational only." }) {',
      "  return <p>{copy}</p>;",
      "}",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", parameter)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);

    const nested = [
      'const { notice: { copy = "Consult a clinician." } = {} } = {};',
      "return <p>{copy}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", nested)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Consult a clinician.</p>",
    ]);
  });

  it("resolves a default attached to an outer nested binding", () => {
    const sample = [
      'const { notice: { copy } = { copy: "Informational only." } } = {};',
      "return <p>{copy}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("applies nested destructuring defaults in runtime order", () => {
    const outerBanned = [
      'const { notice: { copy = "Status" } = { copy: "Informational only." } } = {};',
      "return <p>{copy}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", outerBanned)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);

    const innerBanned = [
      'const { notice: { copy = "Informational only." } = { copy: "Status" } } = {};',
      "return <p>{copy}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", innerBanned)).toEqual([]);
  });

  it("ignores internal-only strings nested in objects and diagnostic functions", () => {
    const sample = [
      'const diagnostic = { message: "Informational only." };',
      "function getDiagnostic() {",
      '  return "Consult a clinician.";',
      "}",
      "console.debug(diagnostic, getDiagnostic);",
      "return <p>Status</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([]);
  });

  it("limits a catch binding to its catch-clause scope", () => {
    const sample = [
      'const spacing = " ";',
      "const disclaimer = `Informational${spacing}only.`;",
      "try {",
      "  run();",
      "} catch (disclaimer) {",
      "  console.debug(disclaimer);",
      "}",
      "return <p>{disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:2 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("stops safely when rendered const bindings form a cycle", () => {
    const sample = [
      "const first = `${second}`;",
      "const second = `${first}`;",
      "return <p>{first}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([]);
  });

  it("does not decode HTML entity spelling inside a JavaScript template", () => {
    const sample = [
      "const rawEntity = `Informational&nbsp;only.`;",
      "<code>{rawEntity}</code>",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([]);
  });

  it("decodes rendered whitespace entities in JSX string attributes", () => {
    const sample = [
      '<p title="Informational&nbsp;only.">Status</p>',
      '<button aria-label="Consult&#32;a clinician.">Help</button>',
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: Informational only.",
      "synthetic.tsx:2 — disclaimer prose in: Consult a clinician.",
    ]);
  });

  it("ignores non-user metadata attributes", () => {
    const sample = '<p data-diagnostic="Informational only.">Status</p>';
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([]);
  });

  it("scans known shared-component copy props and direct accessibility copy", () => {
    const samples = [
      '<EmptyState message="Informational only." />',
      '<PageHeader subtitle="Informational only." />',
      '<Field label="Informational only." />',
      '<EmptyState description="Informational only." />',
      '<List emptyText="Informational only." />',
      '<div aria-valuetext="Informational only." />',
      '<ExplorerShell hint="Informational only." />',
      '<LeadFold summary="Informational only." />',
      '<TodayMedRow detail="Informational only." />',
      '<Welcome onboardingCopy="Informational only." />',
    ];
    for (const sample of samples) {
      expect(disclaimerCopyViolations("synthetic.tsx", sample), sample).toEqual(
        ["synthetic.tsx:1 — disclaimer prose in: Informational only."]
      );
    }
    expect(
      disclaimerCopyViolations(
        "synthetic.tsx",
        '<Welcome onClick="Informational only." />'
      )
    ).toEqual([]);
  });

  it("ignores JSX assigned only to an unused diagnostic binding", () => {
    const sample = [
      "const diagnostic = <p>Informational only.</p>;",
      "return <p>Status</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([]);
  });

  it("follows returned JSX bindings but ignores unused JSX callbacks", () => {
    const returned = [
      "const content = <p>Informational only.</p>;",
      "return content;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", returned)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);

    const unusedCallback = [
      "const diagnostic = () => <p>Informational only.</p>;",
      "return <p>Status</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", unusedCallback)).toEqual(
      []
    );
  });

  it("traces JSX-producing calls only from rendered sinks", () => {
    const renderedCall = [
      "function renderNotice() {",
      "  return <p>Informational only.</p>;",
      "}",
      "return <main>{renderNotice()}</main>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", renderedCall)).toEqual([
      "synthetic.tsx:2 — disclaimer prose in: <main>Informational only.</main>",
    ]);

    const renderedMap =
      "return <main>{items.map(() => <p>Consult a clinician.</p>)}</main>;";
    expect(disclaimerCopyViolations("synthetic.tsx", renderedMap)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <main>Consult a clinician.</main>",
    ]);

    const discarded = [
      "function diagnostic() {",
      "  return <p>Informational only.</p>;",
      "}",
      "diagnostic();",
      "return <p>Status</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", discarded)).toEqual([]);
  });

  it("follows JSX values through property, array, and destructuring paths", () => {
    const samples = [
      [
        "const views = { main: <p>Informational only.</p> };",
        "return views.main;",
      ].join("\n"),
      ["const views = [<p>Informational only.</p>];", "return views[0];"].join(
        "\n"
      ),
      [
        "const { main } = { main: <p>Informational only.</p> };",
        "return main;",
      ].join("\n"),
    ];
    for (const sample of samples) {
      expect(disclaimerCopyViolations("synthetic.tsx", sample), sample).toEqual(
        ["synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>"]
      );
    }
  });

  it("resolves rendered object properties and destructured const bindings", () => {
    const property = [
      'const copy = { disclaimer: `Informational${" "}only.` };',
      "return <p>{copy.disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", property)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);

    const destructured = [
      'const copy = { disclaimer: `Informational${" "}only.` };',
      "const { disclaimer } = copy;",
      "return <p>{disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", destructured)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("resolves a rendered String.raw template", () => {
    const sample = [
      'const disclaimer = String.raw`Informational${" "}only.`;',
      "return <p>{disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("decodes numeric entities embedded within rendered words", () => {
    const sample = "<p>Consult a clini&#99;ian.</p>";
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Consult a clinician.</p>",
    ]);
  });

  it("keeps comment-like URL text visible inside JSX text", () => {
    const sample = "<p>See https://example.test. Informational only.</p>";
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>See https://example.test. Informational only.</p>",
    ]);
  });

  it("detects disclaimer prose split by inline JSX descendants", () => {
    const sample = "<p>Informational <strong>only</strong>.</p>";
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("detects adjacent rendered-whitespace forms without moving their source lines", () => {
    const samples: { label: string; source: string }[] = [
      {
        label: "JSX comment with adjacent text spaces",
        source: "<p>Informational {/* design note */} only.</p>",
      },
      {
        label: "non-breaking entity",
        source: "<p>Informational&nbsp;only.</p>",
      },
      { label: "numeric entity", source: "<p>Informational&#32;only.</p>" },
      {
        label: "alternate named entity",
        source: "<p>Informational&ensp;only.</p>",
      },
      {
        label: "escaped ASCII space expression",
        source: '<p>Informational{"\\u0020"}only.</p>',
      },
      {
        label: "actual NBSP expression",
        source: '<p>Informational{"\u00a0"}only.</p>',
      },
      {
        label: "escaped Unicode em-space expression",
        source: '<p>Informational{"\\u2003"}only.</p>',
      },
    ];
    for (const { label, source } of samples) {
      expect(disclaimerCopyViolations("synthetic.tsx", source), label).toEqual([
        "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
      ]);
    }
  });

  it("stays quiet on non-whitespace JSX joins, entities, expressions, and comments", () => {
    const sample = [
      "<p>Informational{/* no rendered space */}only.</p>",
      "<p>Informational&copy;only.</p>",
      "<p>Informational&#65;only.</p>",
      '<p>Informational{"x"}only.</p>',
      '<p>Informational{"\\u200b"}only.</p>',
      "// Informational&nbsp;only.",
      "{/* Informational only. Consult a clinician. */}",
      "const raw = String.raw/* Informational only. */`camera`;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([]);
  });

  it("tests nested defaults against the actual parent path", () => {
    const unreachableOuter = [
      'const { notice: { copy = "Status" } = { copy: "Informational only." } } = { notice: {} };',
      "return <p>{copy}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", unreachableOuter)).toEqual(
      []
    );

    const reachableInner = [
      'const { notice: { copy = "Informational only." } = { copy: "Status" } } = { notice: {} };',
      "return <p>{copy}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", reachableInner)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>Informational only.</p>",
    ]);
  });

  it("traces named map callbacks only from rendered map results", () => {
    const rendered = [
      "const renderNotice = () => <p>Consult a clinician.</p>;",
      "return <main>{items.map(renderNotice)}</main>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", rendered)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <main>Consult a clinician.</main>",
    ]);

    const discarded = [
      "const renderNotice = () => <p>Consult a clinician.</p>;",
      "items.map(renderNotice);",
      "return <main>Status</main>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", discarded)).toEqual([]);
  });

  it("resolves helpers lexically and stops mutual render-call cycles", () => {
    const shadowedSafe = [
      "function Panel() {",
      "  function renderNotice() { return <p>Status</p>; }",
      "  return <main>{renderNotice()}</main>;",
      "}",
      "function renderNotice() { return <p>Informational only.</p>; }",
      "export function Page() { return <Panel />; }",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", shadowedSafe)).toEqual([]);

    const shadowedBanned = [
      "function Panel() {",
      "  function renderNotice() { return <p>Informational only.</p>; }",
      "  return <main>{renderNotice()}</main>;",
      "}",
      "function renderNotice() { return <p>Status</p>; }",
      "export function Page() { return <Panel />; }",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", shadowedBanned)).toEqual([
      "synthetic.tsx:2 — disclaimer prose in: Informational only.",
    ]);

    const cycle = [
      "function first() { return second(); }",
      "function second() { return first(); }",
      "export function Page() { return <main>{first()}</main>; }",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", cycle)).toEqual([]);
  });

  it("follows inline JSX object, array, and shorthand paths", () => {
    const samples = [
      "return <main>{{ main: <p>Informational only.</p> }.main}</main>;",
      "return <main>{[<p>Informational only.</p>][0]}</main>;",
      [
        "const main = <p>Informational only.</p>;",
        "return <main>{{ main }.main}</main>;",
      ].join("\n"),
    ];
    for (const sample of samples) {
      expect(disclaimerCopyViolations("synthetic.tsx", sample), sample).toEqual(
        [expect.stringContaining("Informational only.")]
      );
    }
  });

  it("projects spread copy props and intrinsic children while keeping data props quiet", () => {
    const samples = [
      '<Notice {...{ message: "Informational only." }} />',
      '<div {...{ "aria-label": "Consult a clinician." }} />',
      '<div children="Informational only." />',
    ];
    for (const sample of samples) {
      expect(
        disclaimerCopyViolations("synthetic.tsx", sample),
        sample
      ).toHaveLength(1);
    }
    expect(
      disclaimerCopyViolations(
        "synthetic.tsx",
        '<Notice {...{ "data-diagnostic": "Informational only." }} />'
      )
    ).toEqual([]);
  });

  it("only follows local PascalCase components from real render sinks", () => {
    const unused = [
      "const Diagnostic = () => <p>Informational only.</p>;",
      "return <p>Status</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", unused)).toEqual([]);

    const rendered = [
      "const Diagnostic = () => <p>Informational only.</p>;",
      "return <Diagnostic />;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", rendered)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: Informational only.",
    ]);
  });

  it("keeps the migrated sites in the scan, outside the allowlist, with canonical links where required", () => {
    const files = new Map(sourceFiles().map((file) => [file.rel, file.text]));
    for (const rel of MIGRATED_DISCLAIMER_SITES) {
      const text = files.get(rel);
      expect(
        text,
        `${rel} must remain in the copy-lint source census`
      ).toBeTypeOf("string");
      expect(DISCLAIMER_COPY_ALLOW.has(rel)).toBe(false);
      expect(disclaimerCopyViolations(rel, text!)).toEqual([]);
    }
    for (const rel of DISCLAIMER_LINK_SITES) {
      expect(files.get(rel)).toContain(`href="${DISCLAIMER_LINK_TARGET}"`);
    }
    expect(files.get("components/ProfilePassport.tsx")).toContain(
      "Growth percentiles use WHO/CDC references for age and sex."
    );
  });

  it("keeps the disclaimer allowlist frozen to the canonical module and page", () => {
    expect([...DISCLAIMER_COPY_ALLOW].sort()).toEqual(
      ["app/(app)/disclaimer/page.tsx", "lib/disclaimers.ts"].sort()
    );
    const knownFiles = new Set(sourceFiles().map((file) => file.rel));
    expect(
      [...DISCLAIMER_COPY_ALLOW].filter((rel) => !knownFiles.has(rel))
    ).toEqual([]);
  });

  it("the cross-profile voice scan detects rendered copy and ignores internal text", () => {
    const sample = [
      "// your comment",
      'console.warn("your diagnostic")',
      'const title = "Your medications";',
      "<p>When you log a dose, it appears here.</p>",
      'const neutral = "This profile’s medications";',
    ].join("\n");
    expect(crossProfileVoiceViolations("synthetic.tsx", sample)).toEqual([
      'synthetic.tsx:3 — second-person copy in: const title = "Your medications";',
      "synthetic.tsx:4 — second-person copy in: <p>When you log a dose, it appears here.</p>",
    ]);
  });

  it("the explicit cross-profile inventory stays honest", () => {
    const knownFiles = new Set(sourceFiles().map((file) => file.rel));
    const missing = [...CROSS_PROFILE_FILES].filter(
      (file) => !knownFiles.has(file)
    );
    expect(
      missing,
      `Explicit cross-profile source files moved or disappeared; update the ` +
        `inventory without weakening its coverage:\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("the ALLOW list stays honest — every entry still matches a real hit", () => {
    const files = sourceFiles();
    const stale: string[] = [];
    for (const a of ALLOW) {
      const f = files.find((x) => x.rel === a.file);
      if (!f || !f.text.includes(a.substring)) {
        stale.push(
          `${a.file}: allowlisted substring no longer present — remove its ALLOW entry.`
        );
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });

  it("the cross-profile voice allowlist stays honest", () => {
    const files = crossProfileSourceFiles();
    const stale: string[] = [];
    for (const a of CROSS_PROFILE_VOICE_ALLOW) {
      const f = files.find((x) => x.rel === a.file);
      if (
        !f ||
        !f.text.includes(a.substring) ||
        !SECOND_PERSON.test(a.substring) ||
        !a.why.trim()
      ) {
        stale.push(
          `${a.file}: voice-allowlisted substring is absent or no longer second-person copy.`
        );
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });
});
