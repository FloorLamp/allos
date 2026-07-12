import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Source-scanning guard for the typed-outcome contract (issue #474). A FormData
// Server Action that did `return;` on a failed validation guard resolved as
// `undefined`, which the consuming form read as SUCCESS — it toasted "Saved ✓" and
// reset, silently losing the entry (same class as the already-fixed #332). The
// passport CRUD surface was migrated to answer with the typed `FormResult`
// (`{ ok:false, error }`) instead. This test keeps the contract from regressing: NO
// EXPORTED action in a listed module may contain a bare `return;` in its body — a
// new guard must `return formError("…")` so the form can surface it.
//
// It's a COARSE guard, not a proof (the repo style — cf. profile-scoping.test.ts):
// it inspects only the brace-matched body of each `export async function`, so a
// bare `return;` in a PRIVATE helper (e.g. medicine's applyDoseStatus, appointments'
// setStatus) is intentionally out of scope. A genuinely-needed bare return inside a
// nested callback of an action should be written `return undefined;` (or refactored)
// — an EMPTY `return;` in an exported action body is exactly the silent-no-op smell
// this catches.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The migrated passport-CRUD action modules (issue #474). Adding a new action
// module to this surface means adding it here — and inheriting the no-bare-return
// contract. (journal/actions.ts already carries the SaveActivityOutcome contract via
// #332; it is covered by its own tests.)
const MODULES = [
  "allergies",
  "conditions",
  "procedures",
  "encounters",
  "immunizations",
  "family-history",
  "care-goals",
  "care-plan",
  "medical",
  "appointments",
  "goals",
  "protocols",
  "medicine",
  "upcoming",
  "trends",
].map((m) => path.join("app", "(app)", m, "actions.ts"));

// Length-preserving neutralizer: blanks the contents of line/block comments and
// string/template literals (keeping newlines) so brace-matching and the bare-return
// search never trip over a `{`, `}`, or the text "return;" that lives inside a
// comment or a SQL string. A tiny hand lexer — enough for these well-formed files.
function neutralize(src: string): string {
  const out: string[] = [];
  type State = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let state: State = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    const keep = (ch: string) => out.push(ch === "\n" ? "\n" : ch);
    const blank = (ch: string) => out.push(ch === "\n" ? "\n" : " ");
    switch (state) {
      case "code":
        if (c === "/" && n === "/") {
          state = "line";
          blank(c);
        } else if (c === "/" && n === "*") {
          state = "block";
          blank(c);
        } else if (c === "'") {
          state = "sq";
          blank(c);
        } else if (c === '"') {
          state = "dq";
          blank(c);
        } else if (c === "`") {
          state = "tpl";
          blank(c);
        } else keep(c);
        break;
      case "line":
        if (c === "\n") state = "code";
        blank(c);
        break;
      case "block":
        if (c === "*" && n === "/") {
          // blank both '*' and '/'
          blank(c);
          blank(n);
          i++;
          state = "code";
        } else blank(c);
        break;
      case "sq":
        if (c === "\\") {
          blank(c);
          if (n !== undefined) {
            blank(n);
            i++;
          }
        } else if (c === "'") {
          state = "code";
          blank(c);
        } else blank(c);
        break;
      case "dq":
        if (c === "\\") {
          blank(c);
          if (n !== undefined) {
            blank(n);
            i++;
          }
        } else if (c === '"') {
          state = "code";
          blank(c);
        } else blank(c);
        break;
      case "tpl":
        // Good enough: template literals in these files carry no `${…}` with
        // braces we need to balance, and no "return;" — blank the whole thing.
        if (c === "\\") {
          blank(c);
          if (n !== undefined) {
            blank(n);
            i++;
          }
        } else if (c === "`") {
          state = "code";
          blank(c);
        } else blank(c);
        break;
    }
  }
  return out.join("");
}

// The [start,end) char ranges of each `export async function`'s body (the region
// between its opening `{` and matching `}`), computed over the neutralized source.
function exportedActionBodies(neutral: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /export\s+async\s+function\s+\w+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(neutral))) {
    // Find the body-opening brace after the parameter list.
    let i = neutral.indexOf("{", m.index);
    if (i < 0) continue;
    let depth = 0;
    const start = i;
    for (; i < neutral.length; i++) {
      if (neutral[i] === "{") depth++;
      else if (neutral[i] === "}") {
        depth--;
        if (depth === 0) {
          ranges.push([start, i + 1]);
          break;
        }
      }
    }
  }
  return ranges;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

describe("passport actions carry the typed FormResult contract (issue #474)", () => {
  for (const rel of MODULES) {
    it(`${rel} has no bare \`return;\` in any exported action body`, () => {
      const abs = path.join(REPO, rel);
      expect(fs.existsSync(abs), `${rel} should exist`).toBe(true);
      const src = fs.readFileSync(abs, "utf8");
      const neutral = neutralize(src);
      const bodies = exportedActionBodies(neutral);
      expect(
        bodies.length,
        `${rel} should export at least one action`
      ).toBeGreaterThan(0);

      const bareReturn = /\breturn\s*;/g;
      const offenders: string[] = [];
      let hit: RegExpExecArray | null;
      while ((hit = bareReturn.exec(neutral))) {
        const idx = hit.index;
        if (bodies.some(([s, e]) => idx >= s && idx < e)) {
          offenders.push(`line ${lineOf(src, idx)}`);
        }
      }
      expect(
        offenders,
        `${rel}: an exported action has a bare \`return;\` — migrate it to \`return formError("…")\` so the form surfaces the failure (issue #474). Offenders: ${offenders.join(", ")}`
      ).toEqual([]);
    });
  }
});
