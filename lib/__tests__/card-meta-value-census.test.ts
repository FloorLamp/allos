import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasBlockSibling,
  topLevelNodes,
  unwrapFragment,
  valueOverflowsItsLine,
} from "../card-meta-value-census";

// The card-mode meta value-shape guard (#3517). The rule, its history and the
// reason it is NOT the rule #3517's own wording describes are all in
// lib/card-meta-value-census.ts — read that first.
//
// This file is the scanner and the corpus. It sweeps every card-mode meta cell in
// app/ and components/ and fails any whose value is several top-level nodes with a
// block-displayed one among them: several flex items on the cell's single line,
// one of them authored to occupy a line of its own. That is the sleep-history
// shape, and it ran a row 29px past its own right edge.
//
// A GREEN SWEEP OVER A COMPLYING TREE SAYS NOTHING ABOUT WHAT THE SWEEP CAN SEE,
// so the second describe below runs the classifier over values authored to break
// it — including the sleep history's own pre-#3499 markup — and, just as
// importantly, over the benign neighbours this tree really contains. A guard that
// flagged `MetricReadingsTable`'s Source or `EncounterList`'s Visit would be
// deleted inside a week and would take the real guard with it.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

// Cells allowed to pass a multi-node block value, each with the reason the shared
// rule deliberately does not apply. There are none: the two the census found were
// FIXED rather than exempted (`VaccineDoseHistory`'s Dose and `FamilyHistoryList`'s
// Condition now wrap their stacks in one node, exactly as the sleep history's naps
// were), because the fix is one element and the exemption is forever.
const ALLOWLIST = new Map<string, string>();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// Blank `//`, `/* */` and `{/* */}` comments while preserving offsets, so reported
// line numbers stay real and a `<div>` inside a comment is not a finding. (Every
// census in lib/__tests__ carries its own copy of this; it is four lines of state
// machine and sharing it would couple unrelated guards.)
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      out += "  ";
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

// The opening tag's text from `<`, ended by the first `>` outside braces/strings.
function tagText(text: string, start: number): string {
  let brace = 0;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === ">" && brace === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

interface Finding {
  file: string;
  label: string;
  line: number;
  nodes: number;
}

// (1) CELLS AUTHORED DIRECTLY. `<Td slot=…>` where the slot expression can yield
// "meta". The repo spells that four ways — `slot="meta"`, and the three positional
// ternaries `slot={i === 0 ? "title" : "meta"}` (RecordTable), `slot={ci === 0 ?
// "value" : "meta"}` (AnalyzeSection) and `slot={col.slot}` (EntryHistoryTable) —
// so the match is on the literal "meta" appearing anywhere in the slot expression
// rather than on the shape the issue happened to name. `slot={col.slot}` resolves
// from data and cannot be read here; it is a generic renderer whose VALUES come
// from its callers, which is what pass (2) reads.
function directCells(rel: string, text: string): Finding[] {
  const out: Finding[] = [];
  const re = /<Td(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const tag = tagText(text, m.index);
    const slot = /slot=(?:"([^"]*)"|\{([^]*?)\}\s*(?=\w+=|\/?>))/.exec(tag);
    const slotText = slot?.[1] ?? slot?.[2] ?? "";
    if (!/\bmeta\b/.test(slotText)) continue;
    if (tag.trimEnd().endsWith("/>")) continue;
    const label = /label=(?:"([^"]*)"|\{([^]*?)\}\s*(?=\w+=|\/?>))/.exec(tag);
    const bodyStart = m.index + tag.length;
    const bodyEnd = text.indexOf("</Td>", bodyStart);
    if (bodyEnd === -1) continue;
    const verdict = valueOverflowsItsLine(text.slice(bodyStart, bodyEnd));
    if (!verdict.offends) continue;
    out.push({
      file: rel,
      label: label?.[1] ?? label?.[2] ?? "(unlabelled)",
      line: lineOf(text, m.index),
      nodes: verdict.nodes,
    });
  }
  return out;
}

// The balanced source of a `cell:` arrow function's returned JSX.
//
// Slicing "from `cell:` to the next `header:`" is NOT good enough and failed
// loudly when it was tried: it swallows the column's own `},` and its neighbour's
// opening brace, so `EncounterList`'s Visit — one `<div>`, correct — read as four
// nodes. A guard whose extractor over-reads reports offences that are artefacts of
// the extractor, which is worse than no guard.
function arrowBody(text: string, from: number): string | null {
  const arrow = text.indexOf("=>", from);
  if (arrow === -1) return null;
  let i = arrow + 2;
  while (i < text.length && /\s/.test(text[i])) i++;
  const balanced = (open: string, close: string, at: number): string | null => {
    let depth = 0;
    let quote: string | null = null;
    for (let j = at; j < text.length; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === quote && text[j - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(at + 1, j);
      }
    }
    return null;
  };
  if (text[i] === "(") return balanced("(", ")", i);
  if (text[i] === "{") {
    // A block body: the JSX is whatever the `return` hands back.
    const block = balanced("{", "}", i);
    if (block == null) return null;
    const ret = block.search(/\breturn\s*\(/);
    if (ret === -1) return null;
    return balanced("(", ")", i + 1 + block.indexOf("(", ret));
  }
  // A bare expression body (`cell: (x) => x.name`) — no JSX children to weigh.
  return null;
}

// (2) CELLS AUTHORED AS COLUMNS. RecordTable renders `columns[i].cell(item)`
// into `slot={i === 0 ? "title" : "meta"}` — so every
// `cell:` in a `RecordColumn` list EXCEPT the first is a meta value, and its shape
// is decided in the consumer, not in the renderer. This is where the two real
// findings were: a scan that stopped at `slot="meta"` reads eleven files and
// misses thirteen.
function columnCells(rel: string, text: string): Finding[] {
  const out: Finding[] = [];
  if (!/RecordColumn</.test(text)) return out;
  const headers = [...text.matchAll(/\bheader:\s*"([^"]*)"/g)];
  const cells = [...text.matchAll(/\bcell:\s*/g)];
  for (const [index, header] of headers.entries()) {
    // The FIRST column is the card's title, never a meta cell.
    if (index === 0) continue;
    const next = headers[index + 1]?.index ?? text.length;
    const cell = cells.find((c) => c.index! > header.index! && c.index! < next);
    if (!cell) continue;
    const body = arrowBody(text, cell.index! + cell[0].length);
    if (body == null) continue;
    const verdict = valueOverflowsItsLine(body);
    if (!verdict.offends) continue;
    out.push({
      file: rel,
      label: header[1],
      line: lineOf(text, header.index!),
      nodes: verdict.nodes,
    });
  }
  return out;
}

export function censusOffenders(): Finding[] {
  const out: Finding[] = [];
  for (const { rel, text } of sourceFiles()) {
    const stripped = stripComments(text);
    for (const f of [
      ...directCells(rel, stripped),
      ...columnCells(rel, stripped),
    ]) {
      if (ALLOWLIST.has(`${f.file}:${f.label}`)) continue;
      out.push(f);
    }
  }
  return out;
}

describe("card-mode meta values are ONE node when they have structure (#3517)", () => {
  it("no card-mode meta cell passes several nodes with a block among them", () => {
    const offenders = censusOffenders();
    expect(
      offenders.map((o) => `${o.file}:${o.line} ${o.label} (${o.nodes} nodes)`),
      "A card-mode meta cell is one non-wrapping flex line below `sm`, so each " +
        "top-level node of its value is a flex ITEM sitting beside the others — " +
        "not the stack a block flow gives it on desktop. These cells pass " +
        "several nodes, at least one of which was authored to start its own " +
        "line, so on a phone they run side by side and can push the card's row " +
        "past its own right edge (#3499 did this to the sleep history's naps: " +
        "29px, invisible to every page-level clipping check because the row " +
        "scrolls and the document does not).\n\n" +
        "THE FIX IS ONE ELEMENT: wrap the value in a single node and let it " +
        "stack inside itself — `components/ResponsiveTable.tsx` says so where " +
        "`label` is documented. Do NOT reach for `flex-wrap` on the cell; the " +
        "row's wrapping is what separates PAIRS, and letting a pair wrap " +
        "internally is the readability defect #3499 fixed."
    ).toEqual([]);
  });

  it("every allowlist entry still names a cell that would otherwise fail", () => {
    const offending = new Set(
      censusOffenders().map((o) => `${o.file}:${o.label}`)
    );
    for (const [key, reason] of ALLOWLIST) {
      expect(
        offending.has(key),
        `${key} allowlisted (${reason}) but clean`
      ).toBe(true);
    }
  });
});

describe("the census can SEE the defect, and stays quiet on its neighbours", () => {
  // THE DEFECT'S OWN SHAPE, verbatim from the sleep history before #3516 fixed it.
  it("flags the sleep history's pre-#3516 naps", () => {
    const naps = `
      {(napsByDate.get(row.date) ?? []).map((nap) => (
        <div key={nap.startMinutes}>{formatSleepWindow(nap)}</div>
      ))}
      <div className="text-xs">total {formatHm(total)}</div>`;
    expect(valueOverflowsItsLine(naps).offends).toBe(true);
  });

  it("flags a block sibling spelled as a class rather than a tag", () => {
    // `<span className="block">` is how the sleep history's own FIX is written, so
    // a census that only knew `<div>` would be blind to the shape of the fix.
    const value = `{label}<span className="block text-xs">Reaction: {r}</span>`;
    expect(valueOverflowsItsLine(value).offends).toBe(true);
  });

  it("flags a fragment of several nodes with one block among them", () => {
    const value = `<>
      {labels.get(im.id) ?? "—"}
      <NotesText notes={im.notes} className="ml-2 text-xs" />
      <span className="block text-xs">{administrationLine(im)}</span>
    </>`;
    expect(valueOverflowsItsLine(value).offends).toBe(true);
  });

  // …AND THE BENIGN NEIGHBOURS, by name. Each of these is really in the tree and
  // really renders 0 overflows at 390px; a guard that flagged them would be
  // deleted within a week and would take the real guard with it.
  it("stays quiet on ONE node that is itself a block (EncounterList's Visit)", () => {
    const value = `<div>
      <Link href={href}>{encounterTypeDisplay(e.type)}</Link>
      <span className="block text-xs">{n} linked records</span>
    </div>`;
    const verdict = valueOverflowsItsLine(value);
    expect(verdict.nodes).toBe(1);
    expect(verdict.offends).toBe(false);
  });

  it("stays quiet on ONE node wrapping a block child (ImmunizationHistory's Lot / route / site)", () => {
    const value = `<span data-testid={"immunization-admin-" + im.id}>
      {immunizationAdministrationLine(im) || "—"}
      {im.reaction ? (
        <span className="block text-xs">Reaction: {im.reaction}</span>
      ) : null}
    </span>`;
    expect(valueOverflowsItsLine(value).offends).toBe(false);
  });

  it("stays quiet on several INLINE nodes (MetricReadingsTable's Source)", () => {
    const value = `{row.source ?? "—"}
      {row.observed && (
        <span className="ml-1 text-xs">observed</span>
      )}`;
    const verdict = valueOverflowsItsLine(value);
    expect(verdict.nodes).toBeGreaterThan(1);
    expect(verdict.block).toBe(false);
    expect(verdict.offends).toBe(false);
  });

  it("stays quiet on a glyph beside its text (the sleep history's Mood)", () => {
    const value = `<>
      <span aria-hidden>{moodFace(row.valence)}</span>{" "}
      {moodLabel(row.valence)} ({row.valence}/5)
    </>`;
    expect(valueOverflowsItsLine(value).offends).toBe(false);
  });

  it("stays quiet on a plain text value", () => {
    expect(
      valueOverflowsItsLine(`{formatDateWithYear(r.date, prefs)}`).offends
    ).toBe(false);
  });

  // The two halves of the rule, isolated — because a guard that fires on either
  // half alone is the noisy guard this one was written to avoid.
  it("a conditional expression is ONE node however much markup it holds", () => {
    const value = `{cond ? <div>a</div> : <div>b</div>}`;
    expect(topLevelNodes(unwrapFragment(value))).toHaveLength(1);
  });

  it("a block DESCENDANT is not a block sibling", () => {
    expect(hasBlockSibling([`<span><div>x</div></span>`])).toBe(false);
    expect(hasBlockSibling([`<div>x</div>`])).toBe(true);
  });
});
