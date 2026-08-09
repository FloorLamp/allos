import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MESSAGE_LINE_MODULES,
  formatEmphasizedLine,
  formatMessageLine,
  formatRichMessageLine,
  messageLineQualifiers,
} from "@/lib/notifications/message-line";
import { bold, plainBody } from "@/lib/notifications/rich-text";
import { REPO } from "./sql-scan";
import { stringLiterals, type Literal } from "./source-literals";

// ---------------------------------------------------------------------------
// THE FORMATTER (#2391)
// ---------------------------------------------------------------------------

describe("formatMessageLine: every combination of present and absent parts", () => {
  it("renders a bare head with no invented punctuation", () => {
    expect(formatMessageLine({ head: "Nothing scheduled" })).toBe(
      "Nothing scheduled"
    );
    expect(formatMessageLine({ glyph: "✅", head: "Nothing scheduled" })).toBe(
      "✅ Nothing scheduled"
    );
    // Empty and whitespace-only parts are absent, not empty slots.
    expect(
      formatMessageLine({
        glyph: "",
        head: "Head",
        because: "  ",
        notes: [null, undefined, ""],
        comparison: null,
        deadline: null,
        link: "",
      })
    ).toBe("Head");
  });

  it("introduces the FIRST present qualifier with an em dash, whichever role it is", () => {
    expect(formatMessageLine({ head: "H", because: "b" })).toBe("H — b");
    expect(formatMessageLine({ head: "H", notes: ["n"] })).toBe("H — n");
    expect(formatMessageLine({ head: "H", comparison: "c" })).toBe("H — c");
    expect(formatMessageLine({ head: "H", deadline: "d" })).toBe("H — d");
  });

  it("separates every later qualifier with a middle dot, in declared role order", () => {
    expect(
      formatMessageLine({
        glyph: "🙋",
        head: "H",
        because: "b",
        notes: ["n1", "n2"],
        comparison: "c",
        deadline: "d",
      })
    ).toBe("🙋 H — b · n1 · n2 · c · d");
    expect(
      formatMessageLine({ head: "H", notes: ["n"], comparison: "c" })
    ).toBe("H — n · c");
    expect(formatMessageLine({ head: "H", because: "b", deadline: "d" })).toBe(
      "H — b · d"
    );
    expect(
      formatMessageLine({ head: "H", comparison: "c", deadline: "d" })
    ).toBe("H — c · d");
  });

  it("appends a link after a space, never as a qualifier", () => {
    expect(
      formatMessageLine({ head: "H", link: "https://example.test/x" })
    ).toBe("H https://example.test/x");
    expect(
      formatMessageLine({
        glyph: "🔌",
        head: "H",
        because: "b",
        link: "https://example.test/x",
      })
    ).toBe("🔌 H — b https://example.test/x");
  });

  it("trims each part so a producer's own padding cannot double a space", () => {
    expect(
      formatMessageLine({ glyph: " 💊 ", head: " Head ", notes: [" note "] })
    ).toBe("💊 Head — note");
  });

  it("exposes the qualifiers in declared order for surfaces that lay out the parts", () => {
    expect(
      messageLineQualifiers({
        head: "H",
        because: "b",
        notes: ["n", null],
        comparison: "c",
        deadline: null,
      })
    ).toEqual(["b", "n", "c"]);
    expect(messageLineQualifiers({ head: "H" })).toEqual([]);
  });
});

describe("formatRichMessageLine: the same grammar, with emphasis", () => {
  it("punctuates identically to the plain formatter", () => {
    const rich = formatRichMessageLine({
      glyph: "🥩",
      head: ["Protein: ", bold("88 g"), " so far"],
      notes: ["goal 100–130 g", "reached"],
    });
    expect(plainBody(rich)).toBe(
      "🥩 Protein: 88 g so far — goal 100–130 g · reached"
    );
    expect(plainBody(rich)).toBe(
      formatMessageLine({
        glyph: "🥩",
        head: "Protein: 88 g so far",
        notes: ["goal 100–130 g", "reached"],
      })
    );
  });

  it("keeps the emphasized run and nothing else", () => {
    const rich = formatRichMessageLine({
      head: ["Protein: ", bold("88 g")],
    });
    expect(typeof rich === "string" ? [] : rich.spans).toEqual([
      { text: "Protein: " },
      { text: "88 g", bold: true },
    ]);
  });

  it("renders a bare rich head with no punctuation", () => {
    expect(plainBody(formatRichMessageLine({ head: ["Head"] }))).toBe("Head");
  });
});

// A ONE-SENTENCE LINE with no qualifiers at all, which is the shape #2376's food-window
// observation needs. It is the case that proves the type earns its keep before there are
// two qualifiers to separate: the producer gets the glyph join and the guarantee that a
// qualifier added later cannot arrive with the wrong punctuation, and the formatter adds
// nothing — no dash, no dot, no parenthesis, and above all no WORDS. The producer's own
// contract (an agentless observation about the ledger, never an accusation) is therefore
// untouched by composing through here.
describe("a head-only line adds nothing to what the producer wrote", () => {
  const AGENCY = /you|your|missed|overdue|skipped|forgot|remember/i;

  for (const when of ["today", "yesterday"] as const) {
    for (const window of ["Morning", "Midday", "Evening"] as const) {
      it(`renders ${window}/${when} as one clause with no invented punctuation`, () => {
        const line = formatRichMessageLine({
          glyph: "📋",
          head: ["Nothing logged for ", bold(window), ` ${when}.`],
        });
        const text = plainBody(line);
        expect(text).toBe(`📋 Nothing logged for ${window} ${when}.`);
        expect(text).not.toMatch(/[—·()]/);
        expect(text).not.toMatch(AGENCY);
      });
    }
  }

  // A HOMOGENEOUS TAIL — N facts of the same kind about one head, which is #2379's
  // nutrition line. `notes` is already the repeating group, so there is no second shape:
  // the `·` between two nutrients is the same job as the `·` between a cause and a
  // deadline, and a per-item hedge ("+") stays inside its own note, which is the only
  // place it can be right when the items disagree about it.
  it("renders a homogeneous list of facts as repeated notes", () => {
    expect(
      formatMessageLine({
        glyph: "🍽️",
        head: "Nutrition",
        notes: ["protein 84 g+ of 95 g", "fiber 18 g of 38 g"],
      })
    ).toBe("🍽️ Nutrition — protein 84 g+ of 95 g · fiber 18 g of 38 g");
    // One nutrient short is one note, and the line still punctuates correctly.
    expect(
      formatMessageLine({
        glyph: "🍽️",
        head: "Nutrition",
        notes: ["protein 84 g+ of 95 g", null],
      })
    ).toBe("🍽️ Nutrition — protein 84 g+ of 95 g");
  });

  // The glyph is a VALUE, so a declared vocabulary (#2392) is a swap at the call site.
  it("takes its glyph from a constant exactly as from a literal", () => {
    const GLYPH = { sleep: "😴" } as const;
    expect(
      formatMessageLine({ glyph: GLYPH.sleep, head: "Last night: 8h" })
    ).toBe(formatMessageLine({ glyph: "😴", head: "Last night: 8h" }));
  });

  it("adds only separators and single spaces — never a word of its own", () => {
    const parts = [
      "GLYPH",
      "HEAD",
      "BECAUSE",
      "NOTE",
      "COMPARISON",
      "DEADLINE",
    ];
    const out = formatMessageLine({
      glyph: parts[0],
      head: parts[1],
      because: parts[2],
      notes: [parts[3]],
      comparison: parts[4],
      deadline: parts[5],
    });
    // Strip the parts and the two declared separators: nothing but spaces may remain.
    let rest = out;
    for (const p of parts) rest = rest.replace(p, "");
    expect(rest.replace(/[—·\s]/g, "")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// THE EMPHASIS RULE (#2392)
// ---------------------------------------------------------------------------

// The rule is one sentence — the head is emphasized when the line has qualifiers to be
// distinguished from — and both halves of it are load-bearing. A message where every
// head is bold has spent its only weight and marks nothing; a bolded prose sentence with
// nothing beside it is the same mistake at line scale.
describe("formatEmphasizedLine: emphasis is contrast, so it is spent on contrast", () => {
  it("bolds the head of a line that HAS qualifiers", () => {
    const line = formatEmphasizedLine({
      glyph: "💊",
      head: "Supplements: 8/9 taken",
      because: "missed Glycine (1 day)",
      notes: ["2 skipped"],
    });
    expect(typeof line === "string" ? [] : line.spans).toEqual([
      { text: "💊 " },
      { text: "Supplements: 8/9 taken", bold: true },
      { text: " — missed Glycine (1 day) · 2 skipped" },
    ]);
  });

  it("leaves a head-only line unemphasized", () => {
    const line = formatEmphasizedLine({
      glyph: "☀️",
      head: "Sunny, UV moderate until 4pm — good window for light exposure.",
    });
    expect(typeof line === "string" ? [] : line.spans).toEqual([
      {
        text: "☀️ Sunny, UV moderate until 4pm — good window for light exposure.",
      },
    ]);
  });

  // THE PARITY GUARANTEE, which is what makes this safe to adopt across the two largest
  // messages the app sends: the words never move. Web Push, Home Assistant and email
  // read plainBody(), and it is byte-identical to the plain formatter over the same
  // parts, emphasized or not.
  it("says exactly what the plain formatter says, on every shape", () => {
    const shapes = [
      { head: "H" },
      { glyph: "🙋", head: "H" },
      { head: "H", because: "b" },
      { glyph: "🔌", head: "H", because: "b", deadline: "d" },
      {
        glyph: "•",
        head: "Workouts: 7",
        notes: ["strength 4, cardio 3"],
        comparison: "5 last week",
      },
      {
        head: "H",
        notes: [null, "n", undefined],
        link: "https://example.test/x",
      },
    ] as const;
    for (const shape of shapes) {
      expect(plainBody(formatEmphasizedLine(shape))).toBe(
        formatMessageLine(shape)
      );
    }
  });
});

// ---------------------------------------------------------------------------
// THE SCAN (#2391)
// ---------------------------------------------------------------------------

// MESSAGE-LINE SCAN. A chokepoint without a scan is a suggestion. A module in the
// DECLARED scope (MESSAGE_LINE_MODULES) may not hand-assemble the grammar's separators
// into a string literal — it composes through formatMessageLine / formatRichMessageLine,
// or it carries an allowlist entry below with a written reason.
//
// Same shape as the repo's other chokepoint scans (lib/__tests__/stateful-writes.test.ts,
// the revalidatePath assertion in nav-routes.test.ts): a text scan over the real tree,
// an allowlist of reviewed survivors each carrying a justification, and a planted fixture
// proving the guard can actually fail.
//
// WHAT IT DOES NOT GUARANTEE, stated so the guarantee isn't overread: it is a TEXT scan
// over string literals. A separator built from a computed expression, or held in a
// constant in an unregistered module and imported, is invisible to it. It also says
// nothing about whether a producer put a fact in the RIGHT role — that is what the
// field contracts on MessageLineParts are for, and what review reads.

// Is this literal ASSEMBLING the grammar, rather than containing its characters?
//
// The distinction the scan has to make is composition versus PROSE. "All weekly targets
// met — nice work." and a registry's `why:` paragraph both contain an em dash and
// neither is a line being built; a template chunk sitting between two interpolated
// values with a spaced separator in it is. So: a spaced (or edge) separator inside a
// template chunk is assembly, and a quoted string counts only when the whole string IS
// the separator.
function assemblesSeparator(lit: Literal): boolean {
  if (lit.kind === "quoted") return /^\s*[—·]\s*$/.test(lit.text);
  return /(^|\s)[—·](\s|$)/.test(lit.text);
}

// A reviewed survivor: a separator inside a registered module that is legitimately NOT a
// message line. Matched on the module plus a substring of the physical source line, so an
// exemption cannot silently widen to the rest of the file.
const ALLOW: { module: string; includes: string; why: string }[] = [
  {
    module: "lib/notifications/offer-tail.ts",
    includes: "it.detail ?",
    why: "An inline KEYBOARD BUTTON label ('💊 Magnesium · 400 mg'), not a message line. A button is a control with a width budget, not a sentence: it has no head-and-qualifiers reading, an em dash would eat characters the label needs, and #1819 item 8 already re-cut this tail's labels for exactly that reason.",
  },
  {
    module: "lib/notifications/correction-rows.ts",
    includes: 'corrected.map((b) => burstLabel(b, tz)).join(" ',
    why: "A LIST of the corrected bursts, not qualifiers of a head: two bursts are two coequal statements of record, neither qualifying the other. The line they sit in ('🕐 Recorded: …') is itself composed through formatMessageLine, which owns its punctuation.",
  },
  {
    module: "lib/notifications/reconcile-core.ts",
    includes: 'parts.join(" ',
    why: "closeDetailText joins per-group outcomes ('Vitamin D taken · Omega-3 skipped') — coequal facts about DIFFERENT items, not qualifiers of one head. Its result is handed to reconcileClosingText as a single declared note, and that line goes through formatMessageLine.",
  },
  {
    module: "lib/notifications/household-round-format.ts",
    includes: "amount ? `${dose.itemName}",
    why: "householdDoseLabel is a dose LABEL shared verbatim by the body list and the confirm buttons, so the two can never name a dose differently (#1719). It is a name-and-amount pair, not a head with a qualifier, and re-punctuating it would either desynchronize the two or push the grammar into a keyboard label.",
  },
  {
    module: "lib/notifications/household-round-format.ts",
    includes: "label: `${GLYPH.done} ${section.name}",
    why: "The confirm BUTTON's label, carrying householdDoseLabel above. Same reason: a button is a control, not a message line.",
  },
  {
    module: "lib/notifications/upcoming-digest.ts",
    includes: "parts.join(nameable ?",
    why: "summarizeBand's band phrase joins NAMED ITEMS or per-domain counts ('colonoscopy · CBC, lipid panel') — a list of coequal due things, none qualifying another (#1819 item 5). The band line that carries it ('🗓️ Overdue: …') is composed through formatMessageLine in digest.ts.",
  },
  {
    module: "lib/notifications/workout-recap-format.ts",
    includes: '[`${lead} done`, ...segs].join(" ',
    why: "importedRecapLine states a LIST of coequal facts an import carried ('Run done · 32 min · 5.2 km'), deliberately shaped like lib/session-recap.ts's strength line so one session reads the same however it arrived (#2272). Re-cutting the session recap's line composition is #2178's decision, not a side effect of landing this chokepoint.",
  },
  {
    module: "lib/notifications/food-format.ts",
    includes: 'if (i > 0) parts.push(" ',
    why: "tallyLine lists the food groups logged today ('✅ Today: 🥬 Leafy greens ×2 · 🫐 Berries ×1', #1016) — a list of coequal counts about different foods, none qualifying another, with the group names emphasized individually.",
  },
  {
    module: "lib/recap.ts",
    includes: "parts.length > 0 ? parts.join(",
    why: "recapLineAnnotation renders the recap CARD's annotation run — a styled <span> beside the value in a dashboard widget, not a message line. It takes its part ORDER from messageLineQualifiers over recapMessageLine, so the card and the Telegram recap can never order or select a line's qualifiers differently (#221); the message itself is composed by formatMessageLine in renderRecapMessage.",
  },
  {
    module: "lib/recap.ts",
    includes: "`recovering ",
    why: "A headline CLAUSE, not a line: the headline is a comma-joined phrase ('4 workouts, 2 PRs') and this is one of its parts, where the em dash is ordinary prose punctuation inside a single clause (#837). Nothing here has a head and qualifiers.",
  },
  {
    module: "lib/notifications/food-format.ts",
    includes: "Ate earlier than you tapped?",
    why: "A HINT PARAGRAPH under the correction chips (#2264), not a line: one sentence explaining what the chips do, where the em dash is ordinary prose punctuation inside that sentence. It read as a quoted string until #2392 gave its glyph a registry reference, which is the only reason the scan can see it at all — the words are unchanged.",
  },
  {
    module: "lib/notifications/preventive-format.ts",
    includes: "profileName ? `${profileName}",
    why: "The message TITLE, where the em dash separates the profile from the screening it is about ('🩺 Preventive care: Alice — Colonoscopy'). Both sides are the subject — there is no head being qualified — and an unnamed profile correctly renders no separator at all.",
  },
];

const MODULE_PATHS = MESSAGE_LINE_MODULES.map((m) => m.module);

interface Violation {
  module: string;
  line: number;
  source: string;
  text: string;
}

export function scanModule(rel: string, src: string): Violation[] {
  // SCOPE IS DECLARED, NOT INFERRED. A module that is not registered is out of scope by
  // construction — `·` joins heart-rate samples in lib/activity-import-details.ts and
  // `—` is ordinary punctuation in page copy, and sweeping those in would produce a
  // lowest-common-denominator abstraction and a scan nobody reads.
  if (!MODULE_PATHS.includes(rel)) return [];
  const physical = src.split("\n");
  const out: Violation[] = [];
  for (const lit of stringLiterals(src)) {
    if (!assemblesSeparator(lit)) continue;
    const source = (physical[lit.line - 1] ?? "").trim();
    if (
      ALLOW.some((a) => a.module === rel && source.includes(a.includes)) ||
      // A multi-line construct: allow a match against the statement's opening lines too,
      // so an exemption anchored on `x.map(...).join(" · ")` still resolves when Prettier
      // has wrapped it.
      ALLOW.some(
        (a) =>
          a.module === rel &&
          physical
            .slice(Math.max(0, lit.line - 4), lit.line)
            .join("")
            .replace(/\s+/g, " ")
            .includes(a.includes)
      )
    )
      continue;
    out.push({ module: rel, line: lit.line, source, text: lit.text });
  }
  return out;
}

describe("message-line scan: the declared scope composes through the formatter", () => {
  it("registers real, unique modules, each with a written reason", () => {
    expect(MESSAGE_LINE_MODULES.length).toBeGreaterThan(5);
    expect(new Set(MODULE_PATHS).size).toBe(MODULE_PATHS.length);
    for (const m of MESSAGE_LINE_MODULES) {
      expect(fs.existsSync(path.join(REPO, m.module)), m.module).toBe(true);
      expect(m.why.length, m.module).toBeGreaterThan(40);
    }
  });

  it("carries a written reason on every allowlist entry", () => {
    for (const a of ALLOW) {
      expect(MODULE_PATHS, a.includes).toContain(a.module);
      expect(a.includes.length, a.includes).toBeGreaterThan(4);
      expect(a.why.length, a.includes).toBeGreaterThan(60);
    }
  });

  it("has no hand-assembled message-line separator in a registered module", () => {
    const violations = MESSAGE_LINE_MODULES.flatMap((m) =>
      scanModule(m.module, fs.readFileSync(path.join(REPO, m.module), "utf8"))
    );
    const report = violations
      .map(
        (v) =>
          `${v.module}:${v.line} assembles "${v.text}" — compose through formatMessageLine, or allowlist it with a reason.\n    ${v.source}`
      )
      .join("\n");
    expect(violations, `\n${report}\n`).toEqual([]);
  });

  it("has no STALE allowlist entry", () => {
    // An exemption that no longer matches anything is a claim about code that has moved
    // on. Each entry must still resolve, so removing a survivor removes its reason too.
    for (const a of ALLOW) {
      const src = fs.readFileSync(path.join(REPO, a.module), "utf8");
      expect(
        src.replace(/\s+/g, " ").includes(a.includes.replace(/\s+/g, " ")),
        `${a.module}: ${a.includes}`
      ).toBe(true);
    }
  });

  // THE FIXTURE THAT PROVES THE GUARD CAN FAIL. It passes today because the tree is
  // clean, which is indistinguishable from a scanner whose tokenizer never matches.
  it("FLAGS a hand-assembled line planted in a registered module", () => {
    const planted = [
      "// A comment about the — grammar and its · separator is prose, not a line.",
      "export function line(title: string, why: string) {",
      "  return `⚑ ${title} — ${why}`;",
      "}",
    ].join("\n");
    const found = scanModule("lib/notifications/digest.ts", planted);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(3);
    // The same source in an UNREGISTERED module is out of scope by declaration.
    expect(scanModule("lib/activity-import-details.ts", planted)).toEqual([]);
  });

  it("sees through a nested template interpolation and past a regex", () => {
    const planted = [
      "const re = /['\"]/;",
      "const base = url.replace(/\\/$/, '');",
      "export const l = (v: string, s: string) =>",
      "  `😴 Last night: ${d}${v ? ` · ${v}` : ''}${s}`;",
    ].join("\n");
    const found = scanModule("lib/notifications/digest.ts", planted);
    expect(found).toHaveLength(1);
    expect(found[0].line).toBe(4);
  });

  it("does not flag an en dash, a hyphen, or a bare emoji glyph", () => {
    const clean = [
      "export const a = `goal 100–130 g`;",
      "export const b = `well-being`;",
      "export const c = `🗓️ ${label}: ${summary}`;",
    ].join("\n");
    expect(scanModule("lib/notifications/digest.ts", clean)).toEqual([]);
  });

  // COMPOSITION VERSUS PROSE is the distinction the scan has to make, and getting it
  // wrong in this direction is what fills a report with noise nobody reads. A quoted
  // sentence is content; a TEMPLATE chunk is composition until a reviewer says otherwise,
  // which is why the recap's headline clause carries an allowlist entry rather than
  // slipping through a heuristic.
  it("does not flag a quoted prose sentence, and does flag a prose template chunk", () => {
    const quoted = [
      'export const TAIL = "Handled in the app — nothing left here.";',
      'export const WHY = { why: "It expires — that is the only deadline it has." };',
    ].join("\n");
    expect(scanModule("lib/notifications/digest.ts", quoted)).toEqual([]);

    const interpolated =
      "export const lead = `recovering — sick ${n} day${n === 1 ? '' : 's'}`;";
    expect(
      scanModule("lib/notifications/digest.ts", interpolated)
    ).toHaveLength(1);
  });
});
