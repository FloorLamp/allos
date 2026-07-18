import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// app/api/** is the #478 JSON-error-body layer, not human copy (issue §1, §Non-goals).
const EXCLUDE_SUBPATH = ["app/api/"];

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
  return files;
}

// Strip block + line comments so prose mentioning a banned phrase (e.g. this file's
// own doc comment, or app/not-found.tsx quoting Next's "could not be found") can't
// trip the scan. The line-comment strip preserves a leading non-`:` char so URLs
// ("https://…") survive.
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
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
});
