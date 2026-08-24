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

function whitespaceOnly(text: string | null): boolean {
  return !!text && /^\s+$/u.test(text);
}

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

function staticStringExpression(
  node: ts.Expression,
  file: ts.SourceFile,
  source: string,
  resolveIdentifier: (
    node: ts.Identifier,
    seen: ReadonlySet<ts.VariableDeclaration>
  ) => ProjectedText | null,
  seen: ReadonlySet<ts.VariableDeclaration> = new Set()
): ProjectedText | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    const start = node.getStart(file);
    return decodeJsStringContent(
      source.slice(start + 1, node.end - 1),
      start + 1
    );
  }
  if (ts.isTemplateExpression(node)) {
    const headStart = node.head.getStart(file);
    const parts: ProjectedText[] = [];
    const head = decodeJsStringContent(
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
        resolveIdentifier,
        seen
      );
      if (!expression) return null;
      parts.push(expression);
      const literalStart = span.literal.getStart(file);
      const literalEndTrim = ts.isTemplateTail(span.literal) ? 1 : 2;
      const literal = decodeJsStringContent(
        source.slice(literalStart + 1, span.literal.end - literalEndTrim),
        literalStart + 1
      );
      if (!literal) return null;
      parts.push(literal);
    }
    return concatProjected(parts);
  }
  if (ts.isParenthesizedExpression(node)) {
    return staticStringExpression(
      node.expression,
      file,
      source,
      resolveIdentifier,
      seen
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
      resolveIdentifier,
      seen
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
      resolveIdentifier,
      seen
    );
    const right = staticStringExpression(
      node.right,
      file,
      source,
      resolveIdentifier,
      seen
    );
    return left && right ? concatProjected([left, right]) : null;
  }
  if (ts.isIdentifier(node)) return resolveIdentifier(node, seen);
  return null;
}

type ProjectionEdit = { start: number; end: number } & ProjectedText;

type LexicalBinding = {
  name: string;
  scope: ts.Node;
  declaration: ts.VariableDeclaration | null;
};

// Project syntax that is statically known to become rendered text. HTML character
// references decode in JSX text and JSX string attributes, never JavaScript
// strings. JSX expressions resolve only lexical const bindings they actually
// render, transitively and with a cycle guard. Every projected character retains
// an original offset so diagnostics keep exact lines after projection.
function projectStaticRenderedCopy(source: string): ProjectedText {
  const file = ts.createSourceFile(
    "copy-lint.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  // The shared lexical stripper intentionally has no JSX mode, so restore the
  // parser-proven JSX text ranges where `//` and `/*` are rendered characters.
  const visibleSource = stripComments(source).split("");
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
  const bindingNames = (name: ts.BindingName): string[] => {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
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
        ts.isIdentifier(node.name) &&
        node.initializer
          ? node
          : null;
      for (const name of bindingNames(node.name)) {
        bindings.push({
          name,
          scope: enclosingScope(node),
          declaration: eligible,
        });
      }
    } else if (ts.isParameter(node)) {
      for (const name of bindingNames(node.name)) {
        bindings.push({ name, scope: node.parent, declaration: null });
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(file);

  const resolveIdentifier = (
    identifier: ts.Identifier,
    seen: ReadonlySet<ts.VariableDeclaration>
  ): ProjectedText | null => {
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
    if (nearest.length !== 1) return null;
    const declaration = nearest[0].declaration;
    if (!declaration?.initializer || seen.has(declaration)) return null;
    const nextSeen = new Set(seen).add(declaration);
    return staticStringExpression(
      declaration.initializer,
      file,
      source,
      resolveIdentifier,
      nextSeen
    );
  };

  const edits: ProjectionEdit[] = [];
  const addHtmlWhitespaceEdits = (start: number, end: number) => {
    const raw = source.slice(start, end);
    const references = /&(?:#(?:[xX][0-9a-fA-F]+|\d+)|[A-Za-z][A-Za-z0-9]+);/g;
    let match: RegExpExecArray | null;
    while ((match = references.exec(raw)) !== null) {
      const decoded = decodeHtmlCharacterReference(match[0]);
      if (!whitespaceOnly(decoded)) continue;
      edits.push({
        start: start + match.index,
        end: start + match.index + match[0].length,
        text: decoded!,
        origins: Array.from(
          { length: decoded!.length },
          () => start + match!.index
        ),
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node)) {
      if (!node.expression) {
        edits.push({
          start: node.getStart(file),
          end: node.end,
          text: "",
          origins: [],
        });
        return;
      }
      const rendered = staticStringExpression(
        node.expression,
        file,
        source,
        resolveIdentifier
      );
      if (rendered) {
        edits.push({ start: node.getStart(file), end: node.end, ...rendered });
        return;
      }
    }
    if (ts.isJsxText(node)) {
      const start = node.getStart(file);
      for (let offset = start; offset < node.end; offset++) {
        visibleSource[offset] = source[offset];
      }
      addHtmlWhitespaceEdits(start, node.end);
    }
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      const start = node.initializer.getStart(file) + 1;
      addHtmlWhitespaceEdits(start, node.initializer.end - 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const text: string[] = [];
  const origins: number[] = [];
  let cursor = 0;
  const appendIdentity = (end: number) => {
    text.push(visibleSource.slice(cursor, end).join(""));
    for (let offset = cursor; offset < end; offset++) origins.push(offset);
  };
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    if (edit.start < cursor) continue;
    appendIdentity(edit.start);
    text.push(edit.text);
    origins.push(...edit.origins);
    cursor = edit.end;
  }
  appendIdentity(source.length);
  return { text: text.join(""), origins };
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

  const projection = projectStaticRenderedCopy(text);
  const violations = new Set<string>();
  for (const phrasing of DISCLAIMER_PHRASINGS) {
    const flags = `${phrasing.flags.replace(/g/g, "")}g`;
    const matcher = new RegExp(phrasing.source, flags);
    let match: RegExpExecArray | null;
    while ((match = matcher.exec(projection.text)) !== null) {
      const sourceOffset = projection.origins[match.index] ?? 0;
      const line = text.slice(0, sourceOffset).split("\n").length;
      const lineStart = projection.text.lastIndexOf("\n", match.index - 1) + 1;
      const lineEnd = projection.text.indexOf(
        "\n",
        match.index + match[0].length
      );
      const snippet = projection.text
        .slice(lineStart, lineEnd === -1 ? projection.text.length : lineEnd)
        .replace(/\s+/g, " ")
        .trim();
      if (!isInternalLine(snippet)) {
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
      "synthetic.tsx:1 — disclaimer prose in: return <p>Informational only.</p>;",
    ]);
  });

  it("resolves rendered const templates transitively without projecting unrendered constants", () => {
    const rendered = [
      'const spacing = " ";',
      "const disclaimer = `Informational${spacing}only.`;",
      "return <p>{disclaimer}</p>;",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", rendered)).toEqual([
      "synthetic.tsx:2 — disclaimer prose in: return <p>Informational only.</p>;",
    ]);

    const internal = [
      'const spacing = " ";',
      "const disclaimer = `Informational${spacing}only.`;",
      "console.debug(disclaimer);",
    ].join("\n");
    expect(disclaimerCopyViolations("synthetic.tsx", internal)).toEqual([]);
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
      'synthetic.tsx:1 — disclaimer prose in: <p title="Informational only.">Status</p>',
      'synthetic.tsx:2 — disclaimer prose in: <button aria-label="Consult a clinician.">Help</button>',
    ]);
  });

  it("keeps comment-like URL text visible inside JSX text", () => {
    const sample = "<p>See https://example.test. Informational only.</p>";
    expect(disclaimerCopyViolations("synthetic.tsx", sample)).toEqual([
      "synthetic.tsx:1 — disclaimer prose in: <p>See https://example.test. Informational only.",
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
