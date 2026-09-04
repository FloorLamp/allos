import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript-api";
import { findTags, scanDirs, walkTsx, REPO } from "./jsx-tag-scan";

// One "when" control (issue #2236). A raw <input type="time"> asks "when did this
// happen?" without the shared rules that question carries — the pair moves
// together, null means "not stated", a stated time is never seeded from a record
// stamp, never default to now but offer it, absolute local times only, and it
// renders the login's own 12h/24h preference rather than the browser's locale.
// `components/WhenControl.tsx` (an observed event's date+time pair) and
// `components/TimeField.tsx` (the styled clock every other surface renders now,
// a plan's or an event's alike) own those rules, so a raw time input has nowhere
// left to hide. Read the app's own TSX as TEXT — no DB, no network, so it stays
// "pure" — for a literal `type="time"`, and fail the build on any match.
//
// #4976 TOOK THE LAST FOUR FILES / EIGHT INPUTS TO ZERO: `TimeRangeFields.tsx`
// (the house Start/End pair, and through it the measurements Bed & wake pair in
// its `overnight` mode) and the two plan forms — `NotificationPrefs.tsx`,
// `AppointmentForm.tsx` — all mount `TimeField` now. This is therefore a straight
// ban, not a ratchet: no allowlist to consult, and the ONE exemption is
// `TimeField.tsx` itself — the element every other file's raw input used to be,
// wrapped once here rather than restyled per host.

const SCAN_DIRS = ["app", "components"];
const TIME_FIELD = "components/TimeField.tsx";

/**
 * Every `<input …>` opening tag whose attributes carry `type="time"`, as line
 * numbers. Attribute values may span lines and contain braces/templates (an
 * onChange arrow's `=>` must not read as the tag's `>`), and a tag mentioned
 * inside a comment is not a tag — both handled by the shared reader in
 * ./jsx-tag-scan rather than by a regex.
 */
export function rawTimeInputs(text: string): number[] {
  return findTags(text, "input", (attrs) =>
    /(?:^|\s)type\s*=\s*"time"/.test(attrs)
  );
}

const scanRepo = () => scanDirs(SCAN_DIRS, rawTimeInputs);

describe('raw <input type="time"> is banned (issue #2236 / #4976)', () => {
  // THE ONE EXEMPTION IS THE WRAPPER ITSELF. Every other match is an offender —
  // there is no count to allow and no reason to record, because there is no
  // legitimate reason left: render `TimeField` (a single clock) or
  // `TimeRangeFields` (a Start/End pair, plain or `overnight`) instead.
  it("renders nowhere outside the field that wraps it", () => {
    const offenders: string[] = [];
    for (const [rel, lines] of scanRepo()) {
      if (rel === TIME_FIELD) continue;
      offenders.push(`${rel}:${lines.join(",")}`);
    }
    expect(
      offenders,
      'A raw <input type="time"> asks "when did this happen?" without the shared ' +
        "rules that question carries, and ignores the login's 12h/24h preference. " +
        "Render <TimeField> (components/TimeField.tsx), or <TimeRangeFields> for " +
        "a Start/End pair, instead:\n\n" +
        offenders.join("\n")
    ).toEqual([]);
  });
});

// ── THE UNION (issue #3273) ─────────────────────────────────────────────────
//
// The ratchet above catches a NEW raw time input. It cannot catch the other half of
// the same divergence: a form that writes an instant and offers no time affordance at
// all, or hand-rolls one out of BUTTONS (the food bar's "Eaten: Now / Earlier…" chips
// were exactly that, and chips are not inputs, so the scan above was structurally
// blind to them). #3273's acceptance is the UNION — every quick-log sheet form that
// writes an instant either mounts the shared control or says here why it does not.
//
// The sheet dispatches NINE forms (QuickEntryProvider's switch); eight are below.
// The ninth is `document`, a file upload — it writes no instant of its own, so "when
// did this happen?" is not a question it has to answer and it is not debt.
//
// The list is HAND-WRITTEN and stays short. It is the sheet's own census, not a
// discovered set: enumerating "forms that write an instant" from source is the
// scanner shape this repo does not build, and a wrong entry here is a claim about a
// neighbour's write core that only a person can make.
const SHEET_INSTANT_FORMS = new Map<string, { mounts: boolean; why: string }>([
  [
    "app/(app)/nutrition/FoodLogBar.tsx",
    {
      mounts: true,
      why: "eating-time statement + the correction sheet (#2227)",
    },
  ],
  [
    "app/(app)/trends/MeasurementsQuickAdd.tsx",
    { mounts: true, why: "the form's one shared Time control (#2154)" },
  ],
  [
    "components/stool/StoolTypeControl.tsx",
    {
      mounts: true,
      why: '"Happened earlier?" over the second-grain key (#2785), via the shared statement',
    },
  ],
  [
    "components/practices/LogPracticeButton.tsx",
    {
      mounts: true,
      why: '"Happened earlier?" states the end of Just finished (#3273/#3143), via the shared statement',
    },
  ],
  [
    "components/mood/MoodForm.tsx",
    {
      mounts: false,
      why:
        "THE COUNTER-CASE, not debt: a check-in is a DAY's answer, upserted on " +
        "UNIQUE(profile_id, date) and carrying no instant at all, so its day chips " +
        'are correct and "when did this happen?" is not the question it asks',
    },
  ],
  [
    "components/quick-entry/QuickCyclePanel.tsx",
    {
      mounts: false,
      why: "period start/end are DAYS; the panel states no time and stores none",
    },
  ],
  [
    "components/quick-entry/QuickDoseList.tsx",
    {
      mounts: false,
      why:
        "DEBT, named: a confirm writes intake_item_logs.recorded_at from the tap " +
        "and the sheet cannot state a late one — the correction row (#2206) is the " +
        "repair today; migrates on touch",
    },
  ],
  [
    "components/quick-entry/QuickSubstanceList.tsx",
    {
      mounts: false,
      why: "DEBT, named: a unit tap writes its own instant with no way to state an earlier one; migrates on touch",
    },
  ],
]);

describe("the quick-log sheet's instant forms mount the control or argue (#3273)", () => {
  // WHAT MEMBERSHIP ACTUALLY IS. Mounting the shared statement (#4426) mounts the
  // control — `useTimeStatement` renders a `WhenControl` and nothing else can — so a
  // predicate that only knew the JSX tag read the two surfaces that converged onto it
  // as having LOST the control they still render.
  const mounted = (rel: string) => {
    const src = fs.readFileSync(path.join(REPO, rel), "utf8");
    return src.includes("<WhenControl") || src.includes("useTimeStatement(");
  };

  it.each([...SHEET_INSTANT_FORMS])("%s", (rel, entry) => {
    // Both directions, because only one of them is the one that rots. A `mounts`
    // entry going false is the regression the union exists to catch; an argued entry
    // going true means the surface migrated and its argument is now a stale claim
    // about a file that no longer matches it.
    expect(mounted(rel), entry.why).toBe(entry.mounts);
  });
});

describe("the time-input reader itself", () => {
  it("finds a multi-line tag whose attributes contain braces and arrows", () => {
    expect(
      rawTimeInputs(
        `<input\n  type="time"\n  value={t}\n  onChange={(e) => set(e.target.value > "" ? e.target.value : "")}\n/>`
      )
    ).toEqual([1]);
  });

  it("ignores other input types and non-input tags", () => {
    expect(rawTimeInputs(`<input type="text" /><IconClock type="time" />`)) //
      .toEqual([]);
  });

  it("ignores a tag mentioned in a comment or a string", () => {
    expect(
      rawTimeInputs(
        `// seeds its <input type="time"> with\nconst s = '<input type="time">';\n{/* <input type="time"> */}`
      )
    ).toEqual([]);
  });

  it("counts each of several inputs on their own lines", () => {
    expect(
      rawTimeInputs(
        `<input type="time" />\n<input type="date" />\n<input type="time" name="t" />`
      )
    ).toEqual([1, 3]);
  });
});

// ── EVERY DIRECT `<WhenControl>` MOUNT IS CLASSIFIED (#4426) ─────────────────
//
// THE CRITERION, as #4738's ruling states it: no hand-rolled composition outside the
// shared control or the argued-exclusion register.
//
// #4426 converged THREE of the four hand-rolled "reveal a WhenControl" compositions
// onto `useTimeStatement` — practice, stool and PRN. (PRN was the fourth only until the
// ruling: its day range existed because the illness cockpit had no day of its own, and
// once the Today/Yesterday lift gave the card one, the day came from the surface and the
// statement went back to being the time half.) The food bar is the ONE that did not, and
// BEFORE this register nothing in the tree recorded that — a second could have joined it
// and no check would have noticed, which is the state the criterion existed to end.
//
// So the claim is made over the WHOLE population rather than over a list of suspects:
// every file that mounts the control DIRECTLY is exactly one of the three kinds below,
// and an unclassified mount fails. That is why this is not the allowlist the standing
// ruling refuses. An allowlist is a silent claim — a name in an array that outlives its
// reason and that a reader cannot evaluate. Each entry here carries a reason a reader
// can DISAGREE with, and an `argued` entry additionally carries the issue where the
// disagreement is being settled, so it goes stale loudly when that issue is ruled.
//
// Mounts of the SHARED statement never appear here: they mount no `<WhenControl>` of
// their own, which is the whole point of converging them.
type WhenMount =
  // The shared statement itself — the one legitimate collapsed reveal.
  | { kind: "shared" }
  // An always-on-screen field inside a form, a sheet or an editor. Nothing is
  // collapsed, so there is no reveal to converge; the control IS the field.
  | { kind: "field"; why: string }
  // A collapsed reveal that did NOT converge, with the reason and where it is being
  // decided. The issue number is a literal type: an entry cannot drift onto a
  // different question without the type changing.
  | { kind: "argued"; why: string; issue: "#4738" };

const WHEN_MOUNTS = new Map<string, WhenMount>([
  ["components/TimeStatement.tsx", { kind: "shared" }],
  [
    "app/(app)/nutrition/FoodLogBar.tsx",
    {
      kind: "argued",
      why:
        "THE ONE ARGUED EXCLUSION (#4738 ruling 4). The eating-time statement is a " +
        "STANDING CLAIM ABOUT A SESSION OF TAPS, not one tap's time: sticky for the " +
        "batch by design (#4118's amendment), never spent by the tap it answers — the " +
        "shared statement's rule 4 inverted — and drawn as a Disclosure with a " +
        "stated-time badge at `hour` grain. Converging it needs a stickiness flag plus " +
        "a details/summary shape flag, which is the four-behaviours-one-control shape " +
        "the ruling refuses. A shared sticky statement gets extracted when a SECOND " +
        "surface wants one, with two real instances to shape it",
      issue: "#4738",
    },
  ],
  [
    "app/(app)/nutrition/DayLedger.tsx",
    {
      kind: "field",
      why:
        "#4118's selection-edit `Set time…` — the web's AFTER-THE-FACT correction " +
        "path, reached by selecting rows and asking for it. #4426 is explicit that " +
        "this stays where it is; the shared statement only tells the time AT the tap",
    },
  ],
  [
    "app/(app)/trends/MeasurementsQuickAdd.tsx",
    {
      kind: "field",
      why: "the sitting's one shared Time, above the groups (#2154)",
    },
  ],
  [
    "components/illness/EpisodeTimeline.tsx",
    { kind: "field", why: "the when half of the event editor (#2236)" },
  ],
  [
    "components/illness/SymptomLogBar.tsx",
    {
      kind: "field",
      why: "the reading's time, beside the temperature field (#4424 ruling 5)",
    },
  ],
  [
    "components/medications/HistoricalDoseForm.tsx",
    { kind: "field", why: "the backfill/amend form's date+time pair (#2228)" },
  ],
  [
    "components/nutrition/FoodServingForm.tsx",
    {
      kind: "field",
      why: "the serving's day + eating-time pair (#4424 ruling 1)",
    },
  ],
  [
    "components/stool/StoolForm.tsx",
    { kind: "field", why: "the dated door's own when (#4708)" },
  ],
  [
    "components/substances/SubstanceForm.tsx",
    {
      kind: "field",
      why:
        "the drink's day + drinking-time pair (#3295 phase 1), and the food form's " +
        "sibling for the same reason: nothing is collapsed, the control IS the " +
        "form's date field. The ADD door only, and only for the food-log ledger — " +
        "every other substance rides a day counter with nowhere to put an instant",
    },
  ],
]);

/**
 * Is this source still the hand-rolled composition its argued entry describes? Both
 * halves, because either one going false ends the argument: it must still mount the
 * control ITSELF, and it must not have taken the shared statement.
 */
export function stillHandRolled(src: string): boolean {
  return (
    findTags(src, "WhenControl", () => true).length > 0 &&
    !src.includes("useTimeStatement(")
  );
}

/**
 * Files mounting `<WhenControl>` directly. Comments and strings do not count.
 *
 * PRODUCT SURFACES ONLY. The register below argues, per file, why a hand-rolled
 * composition is the right shape for THAT surface — a question a test file that
 * renders the control to assert its behaviour is not asking. Scanning them would
 * put every such test in a register of surfaces, where its entry would say
 * nothing and its removal would be a false alarm. The raw-time-input ratchet
 * above deliberately keeps scanning them: a raw `<input type="time">` in a
 * fixture is still a second spelling of a time input to keep in step.
 */
export function whenControlMounts(): string[] {
  return [
    ...scanDirs(SCAN_DIRS, (text) => findTags(text, "WhenControl", () => true)),
  ]
    .map(([rel]) => rel)
    .filter((rel) => !rel.includes("/__tests__/"))
    .sort();
}

describe("every direct WhenControl mount is classified (#4426)", () => {
  const mounts = whenControlMounts();

  it("has no mount outside the register", () => {
    const unclassified = mounts.filter((rel) => !WHEN_MOUNTS.has(rel));
    expect(
      unclassified,
      `\nA new hand-rolled "reveal a WhenControl" composition, or a new form field:\n` +
        `${unclassified.join("\n")}\n` +
        `Mount the shared statement (components/TimeStatement.tsx), or classify it above.\n`
    ).toEqual([]);
  });

  // THE STALENESS HALF, and it is the direction the `<WhenControl`-literal bug in the
  // census above failed in: an entry describing a file that no longer mounts anything
  // is a claim about nothing, and it decays silently because nothing else reads it.
  it("has no entry describing a file that no longer mounts", () => {
    const stale = [...WHEN_MOUNTS.keys()].filter(
      (rel) => !mounts.includes(rel)
    );
    expect(
      stale,
      `\nThese entries describe a file that no longer mounts WhenControl — it converged, ` +
        `or it moved. Delete the entry:\n${stale.join("\n")}\n`
    ).toEqual([]);
  });

  // An argued exclusion is only worth more than an allowlist if its reason is
  // READABLE, so the shape is enforced rather than trusted — and STALE IN BOTH
  // DIRECTIONS, because only one of the two is the direction a reader would notice.
  // A file that stopped mounting entirely is caught above; the other direction is a
  // file that QUIETLY ADOPTED the shared statement while keeping its argument for not
  // having, which leaves a paragraph in this register describing a surface that no
  // longer matches it. That is the exact rot that made PRN's entry wrong within a day.
  it.each(
    [...WHEN_MOUNTS].filter(([, m]) => m.kind === "argued") as [
      string,
      { kind: "argued"; why: string; issue: "#4738" },
    ][]
  )("%s argues its exclusion and says where it is decided", (rel, entry) => {
    expect(entry.why.length).toBeGreaterThan(60);
    expect(entry.issue).toBe("#4738");
    expect(
      stillHandRolled(fs.readFileSync(path.join(REPO, rel), "utf8")),
      `${rel} no longer hand-rolls its reveal — it converged, so delete its entry ` +
        `rather than leaving an argument for an exclusion that ended`
    ).toBe(true);
  });

  // THE GUARD CAN SEE. A green sweep over a complying tree says nothing about what
  // the sweep is able to notice, so run it over sources written to break it — and over
  // the benign neighbours it must stay quiet on.
  it.each([
    ["a plain mount", "<WhenControl mode='state' />", 1],
    [
      "a mount inside a reveal",
      "{open ? <WhenControl grain='hour' /> : null}",
      1,
    ],
    ["two mounts in one file", "<WhenControl /><WhenControl />", 2],
    ["a mention in a comment", "// mounts <WhenControl one day", 0],
    ["a mention in a string", 'const s = "<WhenControl>";', 0],
    ["the shared statement's own name", "useTimeStatement({ day })", 0],
  ])("%s → %i mount(s)", (_label, source, count) => {
    expect(findTags(source, "WhenControl", () => true).length).toBe(count);
  });

  // …AND SO CAN THE STALENESS HALF. Run over sources written to break it, because a
  // predicate asserted only over a complying tree is a predicate nobody has watched
  // fail: the converged shape is what every argued entry eventually becomes.
  //
  // DELIBERATELY TREE-INDEPENDENT — this table is green before and after any
  // convergence, and that is the point. It is the positive control for the assertion
  // beside it, which reads the real file and can only ever come back `true` while the
  // register is honest; without this, "the food bar still hand-rolls" would be a green
  // nobody had ever seen go red.
  it.each([
    [
      "a hand-rolled reveal",
      "{open ? <WhenControl grain='hour' /> : null}",
      true,
    ],
    [
      "one that quietly took the shared statement too",
      "const s = useTimeStatement({ day });\n<WhenControl />",
      false,
    ],
    ["one that fully converged", "const s = useTimeStatement({ day });", false],
    ["one that mounts nothing at all", "export const x = 1;", false],
  ])("%s still hand-rolls: %s", (_label, source, expected) => {
    expect(stillHandRolled(source)).toBe(expected);
  });
});

// ── ONE SPELLING OF THE STATEMENT TOGGLE (#4426's rendering ruling) ──────────
//
// The ruling (owner, 2026-09-02): the clock glyph is the ONLY spelling of the
// statement toggle, seated immediately right of the action it modifies, on the
// standard 34px icon button, with "Happened earlier?" as its accessible name — "no
// text 'Happened earlier?' buttons, no 'Earlier dose' links, no 'Now' chips remain on
// adopted surfaces."
//
// MOST OF THAT IS NOW CLOSED BY THE TYPE, WHICH IS WHY THIS SCAN IS SMALL. The door is
// the shared control's own: `useTimeStatement` takes no `label`, returns no combined
// node, and renders the glyph itself, so there is no prop through which a mount could
// spell the question in words and no arrangement in which it draws something else. What
// a type cannot see is the FIFTH DIALECT — a surface that mounts the statement and then
// draws its own text affordance BESIDE the door — and that is this scan's whole subject.
//
// MEMBERSHIP, NOT AN ALLOWLIST (the shape #4753's chip-residual scan settled on): a
// file that CALLS `useTimeStatement` is an adopted surface, as a fact about the file
// rather than as a name in an array. But membership alone makes a sweep that can
// quietly stop looking, so THE CENSUS ITSELF IS ASSERTED: these four surfaces, by name.
// A fifth adopting is a one-line edit here; the four going missing is the vacuity this
// pins, because a pattern that matches nothing passes forever.
//
// READ THROUGH A REAL PARSE rather than through source text. `ts.isStringLiteralLike`
// and `ts.isJsxText` are the two ways rendered copy is written, and a comment quoting a
// retired spelling in order to explain the retirement is correct and must stay — which
// the AST gives for free, and which is also why this adds no comment stripper of its
// own for `lib/__tests__/strip-comments.test.ts`'s registry to grow by.
//
// WHAT IT CANNOT SEE, said plainly because a rule read as exhaustive is worse than none:
//   • THE SEAT. "Immediately right of the action it modifies" is geometry, and only a
//     rendered box can answer it — e2e/illness-episode-followups.spec.ts measures the
//     PRN door against its pill, and e2e/button-height-floor.mobile.spec.ts measures
//     the practice and stool doors against the control box.
//   • COPY THAT ARRIVES AS A PROP, or is composed at runtime. There is no literal.
//   • UNADOPTED SURFACES. The food bar keeps its own statement and is argued for above,
//     in `WHEN_MOUNTS`; it is out of range here for the same reason.
const STATEMENT_CONTROL = "components/TimeStatement.tsx";

// The spellings the ruling retires, as this repo actually wrote them: "Happened
// earlier?" and "Taken earlier?" as a text button's words, "Earlier dose" as the PRN
// row's link, and a bare "Now" chip. Both halves are a PAIR rather than either word
// alone — "earlier" belongs to ordinary copy ("Past due — earlier today") and "now"
// appears in half the sentences these surfaces already say ("Logged type 3 now — …").
const RETIRED_SPELLING =
  /\b(?:happened|taken|logged|given|eaten|done|finished) earlier\b|\bearlier (?:dose|entry|reading|session)\b/i;

/**
 * A bare "Now" chip: the control's WHOLE visible run, never the word in a sentence —
 * and never a bare `"now"` standing somewhere other than in the markup, which on these
 * surfaces is the PRN row's offset key (`log("now")`, `ledger.pending("now")`). That is
 * a wire value four call sites deep in one file, not a label anybody reads, so the
 * chip rule asks where the literal SITS as well as what it says: JSX text, a JSX
 * attribute's value, or a JSX expression child. A "Now" hoisted into a `const` and
 * interpolated is out of reach, like every other runtime-composed spelling above.
 */
const NOW_CHIP = /^\s*now\s*$/i;

/** Is this literal rendered copy — in the markup rather than in an argument list? */
function inMarkup(node: ts.Node): boolean {
  if (ts.isJsxText(node)) return true;
  const parent = node.parent;
  return (
    parent !== undefined &&
    (ts.isJsxAttribute(parent) || ts.isJsxExpression(parent))
  );
}

interface StatementSurface {
  /** Does this file mount the shared statement? */
  adopts: boolean;
  /** Does it draw the door the statement hands it? */
  drawsDoor: boolean;
  /** Retired spellings, as `file:line spelling`. */
  retired: string[];
  /**
   * A SECOND `IconClock` the surface draws itself, as `file:line`. The door's own
   * glyph lives in `components/TimeStatement.tsx` and never appears as a literal
   * tag in a host file — a host only ever writes `{s.door}` — so any `<IconClock`
   * this scan finds here is the host drawing its OWN clock beside the one the
   * control already drew (#4882 owner ruling: "the clock is reserved for the time
   * statement… nothing else on the row spells with a clock").
   */
  clock: string[];
}

export function scanStatementSurface(
  file: string,
  text: string
): StatementSurface {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out: StatementSurface = {
    adopts: false,
    drawsDoor: false,
    retired: [],
    clock: [],
  };
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useTimeStatement"
    )
      out.adopts = true;
    if (ts.isPropertyAccessExpression(node) && node.name.text === "door")
      out.drawsDoor = true;
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) {
      const spelled =
        node.text.match(RETIRED_SPELLING)?.[0] ??
        (inMarkup(node) && NOW_CHIP.test(node.text) ? node.text.trim() : null);
      if (spelled)
        out.retired.push(
          `${file}:${
            source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          } ${spelled}`
        );
    }
    const tagName =
      ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)
        ? node.tagName.getText(source)
        : null;
    if (tagName === "IconClock")
      out.clock.push(
        `${file}:${
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        }`
      );
    ts.forEachChild(node, visit);
  }
  visit(source);
  return out;
}

/**
 * Every adopted surface, found rather than listed. Parsing cannot create the call, so
 * a file whose raw text lacks the name is skipped before the compiler sees it — the
 * same prefilter `chip-residual.test.ts` uses, for the same reason.
 */
function statementSurfaces(): [string, StatementSurface][] {
  return SCAN_DIRS.flatMap((dir) => walkTsx(path.join(REPO, dir)))
    .map((full) => path.relative(REPO, full).split(path.sep).join("/"))
    .filter((rel) => rel !== STATEMENT_CONTROL && !rel.includes("/__tests__/"))
    .flatMap((rel): [string, StatementSurface][] => {
      const text = fs.readFileSync(path.join(REPO, rel), "utf8");
      if (!text.includes("useTimeStatement")) return [];
      const scan = scanStatementSurface(rel, text);
      return scan.adopts ? [[rel, scan]] : [];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

describe("the clock door is the only spelling of the statement (#4426)", () => {
  const surfaces = statementSurfaces();

  it("finds every surface that mounts the statement", () => {
    expect(
      surfaces.map(([rel]) => rel),
      "\nThe adopted surfaces have changed. A NEW one is a one-line edit here — and " +
        "check its door is seated immediately right of the action it modifies, which " +
        "no source scan can see. A surface DISAPPEARING is the direction that matters: " +
        "the rule below would then range over fewer files and go on passing.\n"
    ).toEqual([
      "components/medications/QuickLogPrnControl.tsx",
      "components/medications/ScheduledDoseAction.tsx",
      "components/practices/LogPracticeButton.tsx",
      "components/stool/StoolTypeControl.tsx",
    ]);
  });

  it.each(surfaces)(
    "%s draws the door and no other time affordance",
    (rel, scan) => {
      expect(
        scan.drawsDoor,
        `${rel} mounts the statement and never draws its door, so the surface offers ` +
          `no way to open the reveal at all`
      ).toBe(true);
      expect(
        scan.retired,
        `${rel} spells the statement a second way. The clock door is the only spelling ` +
          `(owner ruling, 2026-09-02): delete the text affordance rather than seating it ` +
          `beside the glyph.`
      ).toEqual([]);
      // #4882 owner ruling (2026-09-03): the clock glyph is reserved for the time
      // statement, and nothing else on an adopted surface's row spells with a clock.
      // The door's own `IconClock` lives in TimeStatement.tsx, so a `<IconClock` this
      // scan finds HERE is a second clock the host drew itself — the two-clock practice
      // row the issue reported, generalized to every surface that could grow one.
      expect(
        scan.clock,
        `${rel} draws its own IconClock beside the statement's door. The clock is ` +
          `reserved for the time statement (owner ruling, 2026-09-03): give this ` +
          `affordance a different glyph.`
      ).toEqual([]);
    }
  );

  // THE SHARED CONTROL'S OWN DEFINITION SPELLS THE QUESTION, and must. It is the one
  // place the words are written — as the door's accessible name — so this is asserted
  // rather than assumed: if the exclusion above ever stopped excluding it, the rule
  // would fire on the very control it exists to protect.
  it("does not range over the control that owns the question", () => {
    const control = scanStatementSurface(
      STATEMENT_CONTROL,
      fs.readFileSync(path.join(REPO, STATEMENT_CONTROL), "utf8")
    );
    expect(control.retired.length).toBeGreaterThan(0);
    expect(surfaces.map(([rel]) => rel)).not.toContain(STATEMENT_CONTROL);
  });

  // THE GUARD CAN SEE. A green sweep over a complying tree says nothing about what the
  // sweep is able to notice, so run it over sources authored to break it — every
  // retired dialect the ruling names — and over the benign neighbours it must stay
  // quiet on, which are real sentences these surfaces already say.
  const MOUNT = "const s = useTimeStatement({ day });\n";
  // A POSITIONAL `%i` IN THE TITLE LANDS ON THE SECOND ELEMENT — the source — and
  // printed "reports NaN" on all eight rows. The expectation reads in the message
  // instead, where a failure actually shows it.
  it.each([
    [
      "a text button beside the door",
      `${MOUNT}<><button>Happened earlier?</button>{s.door}</>`,
      1,
    ],
    [
      "the scheduled dose's own words",
      `${MOUNT}<><button aria-label="Taken earlier?" />{s.door}</>`,
      1,
    ],
    [
      "the PRN row's link",
      `${MOUNT}<><a href="#">Earlier dose</a>{s.door}</>`,
      1,
    ],
    ["a Now chip", `${MOUNT}<><Chip>Now</Chip>{s.door}</>`, 1],
    [
      "a comment quoting a retired spelling",
      `// "Happened earlier?" retired here (#4426).\n${MOUNT}<>{s.door}</>`,
      0,
    ],
    [
      "prose that says earlier about a day",
      `${MOUNT}<>{"Past due — earlier today"}{s.door}</>`,
      0,
    ],
    [
      "a sentence that says now",
      `${MOUNT}<>{\`Logged type 3 now — 07:05 hasn't happened yet.\`}{s.door}</>`,
      0,
    ],
    [
      "a bare `now` used as a wire value rather than as copy",
      `${MOUNT}<><button onClick={() => log("now")} />{s.door}</>`,
      0,
    ],
  ])("%s", (label, source, count) => {
    expect(
      scanStatementSurface("components/Plant.tsx", source).retired,
      `${label} should report ${count} retired spelling(s)`
    ).toHaveLength(count);
  });

  // THE `clock` FIELD, on the same "guard can see" terms: fire on a forged second
  // IconClock beside the door, and stay quiet on the benign neighbours a real surface
  // draws all the time — the door itself (as `{s.door}`, never a literal tag) and an
  // unrelated icon that merely shares the "Icon" prefix.
  it.each([
    [
      "a second IconClock beside the door",
      `${MOUNT}<><button><IconClock />Details</button>{s.door}</>`,
      1,
    ],
    [
      "a second IconClock, self-closing with props",
      `${MOUNT}<><IconClock className="h-4 w-4" stroke={2} aria-hidden />{s.door}</>`,
      1,
    ],
    [
      "the door alone — {s.door} is a property access, never a literal tag",
      `${MOUNT}<>{s.door}</>`,
      0,
    ],
    [
      "an unrelated icon beside the door",
      `${MOUNT}<><IconListDetails />{s.door}</>`,
      0,
    ],
  ])("%s", (label, source, count) => {
    expect(
      scanStatementSurface("components/Plant.tsx", source).clock,
      `${label} should report ${count} host-drawn IconClock(s)`
    ).toHaveLength(count);
  });

  it.each([
    ["a mount that draws the door", `${MOUNT}<>{s.door}</>`, true, true],
    ["a mount that never draws it", `${MOUNT}<>{s.reveal}</>`, true, false],
    [
      "a file that only names the hook in prose",
      "// useTimeStatement owns this\n",
      false,
      false,
    ],
  ])("%s", (label, source, adopts, draws) => {
    const scan = scanStatementSurface("components/Plant.tsx", source);
    expect(scan.adopts, `${label} adopts: ${adopts}`).toBe(adopts);
    expect(scan.drawsDoor, `${label} draws the door: ${draws}`).toBe(draws);
  });
});
