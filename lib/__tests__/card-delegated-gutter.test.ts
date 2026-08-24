import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";
import { makeTmpDir } from "./tmp-dir";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const TOKENS = [
  "card-delegated",
  "card-gutter-standard",
  "card-gutter-compact",
  "card-gutter-action",
] as const;
type Token = (typeof TOKENS)[number];

interface Anchor {
  site: string;
  file: string;
  needle: string;
  count: number;
  token: Token;
  ownerNeedle?: string;
  viaComponent?: string;
}

interface LayoutAnchor {
  site: string;
  file: string;
  needle: string;
  count: number;
  ownerNeedle: string;
  className: string;
}

// This is deliberately a small DOM-tag registry, not an expression interpreter.
// Every delegated parent and every rendered gutter carrier has one stable anchor.
const ADOPTERS: readonly Anchor[] = [
  {
    site: "period-stats",
    file: "app/(app)/trends/metric/[kind]/page.tsx",
    needle: 'data-testid="metric-period-stats"',
    count: 1,
    token: "card-delegated",
  },
  {
    site: "period-stats",
    file: "app/(app)/trends/metric/[kind]/page.tsx",
    needle: 'data-testid="metric-period-stats-header"',
    count: 1,
    token: "card-gutter-standard",
    ownerNeedle: 'data-testid="metric-period-stats"',
  },
  {
    site: "period-stats",
    file: "app/(app)/trends/metric/[kind]/page.tsx",
    needle: 'data-card-delegated-cell="period-stat"',
    count: 1,
    token: "card-gutter-standard",
    ownerNeedle: 'data-testid="metric-period-stats"',
  },
  {
    site: "metric-readings",
    file: "components/MetricReadingsTable.tsx",
    needle: 'data-testid="metric-readings"',
    count: 2,
    token: "card-delegated",
  },
  {
    site: "metric-readings",
    file: "components/MetricReadingsTable.tsx",
    needle: 'data-testid="metric-readings-header"',
    count: 1,
    token: "card-gutter-standard",
    ownerNeedle: 'data-testid="metric-readings"',
    viaComponent: "ReadingsHeader",
  },
  {
    site: "metric-readings",
    file: "components/MetricReadingsTable.tsx",
    needle: 'data-testid="metric-readings-body"',
    count: 2,
    token: "card-gutter-compact",
    ownerNeedle: 'data-testid="metric-readings"',
  },
  {
    site: "trend-mini-compact",
    file: "components/TrendMiniCard.tsx",
    needle: 'data-card-delegated-site="trend-mini-compact"',
    count: 1,
    token: "card-delegated",
  },
  {
    site: "trend-mini-compact",
    file: "components/TrendMiniCard.tsx",
    needle: 'data-card-delegated-cell="trend-mini-compact-header"',
    count: 1,
    token: "card-gutter-standard",
    ownerNeedle: 'data-card-delegated-site="trend-mini-compact"',
  },
  {
    site: "trend-mini-compact",
    file: "components/TrendMiniCard.tsx",
    needle: 'data-card-delegated-cell="trend-mini-compact-action"',
    count: 1,
    token: "card-gutter-action",
    ownerNeedle: 'data-card-delegated-site="trend-mini-compact"',
  },
];

// The only non-literal className ancestors between a delegated parent and one
// of its carriers. They own responsive layout/borders, never horizontal gutter.
const LAYOUTS: readonly LayoutAnchor[] = [
  {
    site: "period-stats",
    file: "app/(app)/trends/metric/[kind]/page.tsx",
    needle: 'data-card-delegated-layout="period-stats-grid"',
    count: 1,
    ownerNeedle: 'data-testid="metric-period-stats"',
    className:
      '{`grid grid-cols-1 ${ desktopSidebar ? `xl:grid-cols-1 ${PERIOD_COLS[stats.length] ?? "sm:grid-cols-3"}` : (PERIOD_COLS[stats.length] ?? "sm:grid-cols-3") }`}',
  },
  {
    site: "period-stats",
    file: "app/(app)/trends/metric/[kind]/page.tsx",
    needle: 'data-card-delegated-layout="period-stat-border"',
    count: 1,
    ownerNeedle: 'data-testid="metric-period-stats"',
    className:
      "{`min-w-0 ${periodItemBorders( i, periodGridCols(stats.length), desktopSidebar )}`}",
  },
];

const PROTOCOL_P0 = {
  file: "app/(app)/protocols/ProtocolCompare.tsx",
  className: "btn-ghost btn-sm h-8 w-8 p-0!",
};

function classToken(name: string): RegExp {
  return new RegExp(
    `(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`
  );
}

function uiSources(
  root: string
): ReadonlyArray<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = [];
  const walk = (dir: string) => {
    const absolute = path.join(root, dir);
    if (!fs.existsSync(absolute)) return;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) {
        out.push({
          file,
          source: stripComments(fs.readFileSync(path.join(root, file), "utf8")),
        });
      }
    }
  };
  walk("app");
  walk("components");
  return out;
}

interface TagSpan {
  start: number;
  end: number;
  text: string;
}

function tagSpanAt(source: string, start: number): TagSpan {
  let braces = 0;
  let quote = "";
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === quote && source[i - 1] !== "\\") quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") braces += 1;
    else if (c === "}") braces -= 1;
    else if (c === ">" && braces === 0) {
      return { start, end: i + 1, text: source.slice(start, i + 1) };
    }
  }
  throw new Error(`unterminated JSX tag at offset ${start}`);
}

function openingTagSpansWith(source: string, needle: string): TagSpan[] {
  const tags: TagSpan[] = [];
  let offset = 0;
  while (true) {
    const at = source.indexOf(needle, offset);
    if (at < 0) return tags;
    const start = source.lastIndexOf("<", at);
    if (start < 0) throw new Error(`${needle} is not inside a JSX tag`);
    const tag = tagSpanAt(source, start);
    tags.push(tag);
    offset = tag.end;
  }
}

function openingTagsWith(source: string, needle: string): string[] {
  return openingTagSpansWith(source, needle).map((tag) => tag.text);
}

function elementRange(
  source: string,
  opening: TagSpan
): readonly [number, number] {
  const name = opening.text.match(/^<([A-Za-z][\w.]*)\b/)?.[1];
  if (!name || /\/\s*>$/.test(opening.text))
    return [opening.start, opening.end];
  const token = new RegExp(`<\\/?${name.replace(".", "\\.")}\\b`, "g");
  token.lastIndex = opening.end;
  let depth = 1;
  for (const match of source.matchAll(token)) {
    const tag = tagSpanAt(source, match.index);
    if (tag.text.startsWith(`</${name}`)) depth -= 1;
    else if (!/\/\s*>$/.test(tag.text)) depth += 1;
    if (depth === 0) return [opening.start, tag.end];
    token.lastIndex = tag.end;
  }
  throw new Error(`unterminated <${name}> element`);
}

function functionBlockRange(
  source: string,
  name: string
): readonly [number, number] | null {
  const signature = source.indexOf(`function ${name}`);
  const start = source.indexOf("{", signature);
  if (signature < 0 || start < 0) return null;
  let depth = 0;
  let quote = "";
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === quote && source[i - 1] !== "\\") quote = "";
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return [start, i + 1];
    }
  }
  return null;
}

function literalClassName(tag: string): string {
  const match = tag.match(/className\s*=\s*"([^"]*)"/);
  if (!match) throw new Error("registered tag must use a literal className");
  return match[1];
}

function classNameValue(tag: string): string {
  const at = tag.indexOf("className=");
  if (at < 0) throw new Error("tag carries no className");
  return tag
    .slice(at + "className=".length, tag.lastIndexOf(">"))
    .trim()
    .replace(/\s+/g, " ");
}

function classTagSpansWithin(
  source: string,
  start: number,
  end: number
): TagSpan[] {
  const spans = new Map<number, TagSpan>();
  for (const match of source.slice(start, end).matchAll(/className\s*=/g)) {
    const at = start + match.index;
    const tagStart = source.lastIndexOf("<", at);
    if (tagStart >= start) spans.set(tagStart, tagSpanAt(source, tagStart));
  }
  return [...spans.values()];
}

function horizontalPaddingTokens(tag: string): string[] {
  const className = tag.slice(tag.indexOf("className="));
  return [...className.matchAll(/["'`]([^"'`]*)["'`]/g)]
    .flatMap((match) => match[1].split(/\s+/))
    .filter((token) => isPadding(token, true));
}

function literalTokenCount(source: string, token: Token): number {
  let count = 0;
  for (const match of source.matchAll(/className\s*=\s*"([^"]*)"/g)) {
    if (classToken(token).test(match[1])) count += 1;
  }
  return count;
}

function rawTokenCount(source: string, token: string): number {
  return [...source.matchAll(new RegExp(classToken(token).source, "g"))].length;
}

function isPadding(token: string, horizontalOnly: boolean): boolean {
  const leaf = token.split(":").at(-1)?.replace(/^!|!$/g, "") ?? "";
  return horizontalOnly
    ? /^(?:p|px|pl|pr|ps|pe)-/.test(leaf)
    : /^(?:p|px|py|pt|pb|pl|pr|ps|pe)-/.test(leaf);
}

function contractProblems(
  root: string,
  adopters: readonly Anchor[],
  layouts: readonly LayoutAnchor[] = LAYOUTS
): string[] {
  const files = uiSources(root);
  const byFile = new Map(files.map((entry) => [entry.file, entry.source]));
  const problems: string[] = [];

  for (const token of TOKENS) {
    const raw = files.reduce(
      (n, entry) => n + rawTokenCount(entry.source, token),
      0
    );
    const literal = files.reduce(
      (n, entry) => n + literalTokenCount(entry.source, token),
      0
    );
    const registered = adopters
      .filter((entry) => entry.token === token)
      .reduce((n, entry) => n + entry.count, 0);
    if (raw !== literal)
      problems.push(
        `${token}: ${raw} raw occurrence(s), ${literal} literal class occurrence(s)`
      );
    if (literal !== registered)
      problems.push(
        `${token}: ${literal} literal occurrence(s), ${registered} registered tag(s)`
      );
  }

  for (const adopter of adopters) {
    const source = byFile.get(adopter.file);
    if (!source) {
      problems.push(`${adopter.file}: registered file is missing`);
      continue;
    }
    const tags = openingTagsWith(source, adopter.needle);
    if (tags.length !== adopter.count) {
      problems.push(
        `${adopter.file}: ${adopter.needle} occurs ${tags.length} time(s), expected ${adopter.count}`
      );
      continue;
    }
    for (const tag of tags) {
      let classes: string;
      try {
        classes = literalClassName(tag);
      } catch (error) {
        problems.push(
          `${adopter.file}: ${adopter.needle}: ${(error as Error).message}`
        );
        continue;
      }
      if (!classToken(adopter.token).test(classes))
        problems.push(
          `${adopter.file}: ${adopter.needle} is missing ${adopter.token}`
        );
      const localPadding = classes
        .split(/\s+/)
        .filter((token) =>
          isPadding(token, adopter.token !== "card-delegated")
        );
      if (localPadding.length)
        problems.push(
          `${adopter.file}: ${adopter.needle} overrides its token with ${localPadding.join(" ")}`
        );
      if (
        adopter.token === "card-delegated" &&
        !classToken("card").test(classes)
      )
        problems.push(
          `${adopter.file}: ${adopter.needle} must compose card with card-delegated`
        );
    }

    if (adopter.ownerNeedle) {
      const carriers = openingTagSpansWith(source, adopter.needle);
      const owners = openingTagSpansWith(source, adopter.ownerNeedle).map(
        (tag) => elementRange(source, tag)
      );
      if (adopter.viaComponent) {
        const component = functionBlockRange(source, adopter.viaComponent);
        if (
          !component ||
          carriers.some(
            (carrier) =>
              carrier.start < component[0] || carrier.end > component[1]
          )
        ) {
          problems.push(
            `${adopter.file}: ${adopter.needle} is not the rendered root of ${adopter.viaComponent}`
          );
        }
        for (const [start, end] of owners) {
          if (!source.slice(start, end).includes(`<${adopter.viaComponent}`)) {
            problems.push(
              `${adopter.file}: ${adopter.ownerNeedle} does not render ${adopter.viaComponent}`
            );
          }
        }
      } else {
        for (const carrier of carriers) {
          if (
            !owners.some(
              ([start, end]) => carrier.start > start && carrier.end < end
            )
          ) {
            problems.push(
              `${adopter.file}: ${adopter.needle} is outside its ${adopter.ownerNeedle} card`
            );
          }
        }
        for (const [start, end] of owners) {
          if (
            !carriers.some(
              (carrier) => carrier.start > start && carrier.end < end
            )
          ) {
            problems.push(
              `${adopter.file}: ${adopter.ownerNeedle} has no ${adopter.needle} carrier`
            );
          }
        }
      }
    }
  }

  const expectedLayouts = layouts.reduce(
    (sum, layout) => sum + layout.count,
    0
  );
  const observedLayouts = files.reduce(
    (sum, entry) =>
      sum + rawTokenCount(entry.source, "data-card-delegated-layout"),
    0
  );
  if (observedLayouts !== expectedLayouts) {
    problems.push(
      `delegated layouts: ${observedLayouts} occurrence(s), ${expectedLayouts} registered tag(s)`
    );
  }
  for (const layout of layouts) {
    const source = byFile.get(layout.file);
    if (!source) {
      problems.push(`${layout.file}: registered layout file is missing`);
      continue;
    }
    const tags = openingTagSpansWith(source, layout.needle);
    if (tags.length !== layout.count) {
      problems.push(
        `${layout.file}: ${layout.needle} occurs ${tags.length} time(s), expected ${layout.count}`
      );
      continue;
    }
    for (const tag of tags) {
      if (classNameValue(tag.text) !== layout.className.replace(/\s+/g, " ")) {
        problems.push(
          `${layout.file}: ${layout.needle} changed its registered layout-only className`
        );
      }
      if (horizontalPaddingTokens(tag.text).length > 0) {
        problems.push(
          `${layout.file}: ${layout.needle} carries horizontal padding`
        );
      }
      const insideOwner = openingTagSpansWith(source, layout.ownerNeedle)
        .map((owner) => elementRange(source, owner))
        .some(([start, end]) => tag.start > start && tag.end < end);
      if (!insideOwner) {
        problems.push(
          `${layout.file}: ${layout.needle} is outside ${layout.ownerNeedle}`
        );
      }
    }
  }

  for (const parent of adopters.filter(
    (entry) => entry.token === "card-delegated"
  )) {
    if (
      !adopters.some(
        (entry) =>
          entry.site === parent.site && entry.token !== "card-delegated"
      )
    ) {
      problems.push(
        `${parent.site}: delegated card has no registered gutter carrier`
      );
    }

    const source = byFile.get(parent.file);
    if (!source) continue;
    const carrierSpans = adopters
      .filter(
        (entry) =>
          entry.site === parent.site &&
          entry.ownerNeedle === parent.needle &&
          !entry.viaComponent
      )
      .flatMap((entry) => openingTagSpansWith(source, entry.needle));
    const carrierRanges = carrierSpans.map((tag) => elementRange(source, tag));
    const registeredLayoutStarts = new Set(
      layouts
        .filter(
          (layout) => layout.site === parent.site && layout.file === parent.file
        )
        .flatMap((layout) =>
          openingTagSpansWith(source, layout.needle).map((tag) => tag.start)
        )
    );
    for (const parentTag of openingTagSpansWith(source, parent.needle)) {
      const [start, end] = elementRange(source, parentTag);
      const classTags = classTagSpansWithin(source, start, end);
      for (const carrier of carrierSpans.filter(
        (tag) => tag.start > start && tag.end < end
      )) {
        for (const ancestor of classTags) {
          if (
            ancestor.start === parentTag.start ||
            ancestor.start === carrier.start ||
            /className\s*=\s*"/.test(ancestor.text)
          ) {
            continue;
          }
          const [ancestorStart, ancestorEnd] = elementRange(source, ancestor);
          if (
            ancestorStart < carrier.start &&
            ancestorEnd > carrier.end &&
            !registeredLayoutStarts.has(ancestor.start)
          ) {
            problems.push(
              `${parent.file}: unresolved className lies between ${parent.needle} and a registered carrier`
            );
          }
        }
      }
      for (const tag of classTags) {
        const horizontal = horizontalPaddingTokens(tag.text);
        if (
          horizontal.length > 0 &&
          !carrierRanges.some(
            ([carrierStart, carrierEnd]) =>
              tag.start >= carrierStart && tag.end <= carrierEnd
          )
        ) {
          problems.push(
            `${parent.file}: ${parent.needle} has an unregistered horizontal-padding carrier: ${horizontal.join(" ")}`
          );
        }
      }
    }
  }

  const p0 = files.flatMap((entry) =>
    Array.from(
      { length: rawTokenCount(entry.source, "p-0!") },
      () => entry.file
    )
  );
  const protocolSource = byFile.get(PROTOCOL_P0.file) ?? "";
  const protocolTags = openingTagsWith(
    protocolSource,
    `className="${PROTOCOL_P0.className}"`
  );
  if (
    p0.length !== 1 ||
    p0[0] !== PROTOCOL_P0.file ||
    protocolTags.length !== 1 ||
    !protocolTags[0].startsWith("<button")
  ) {
    problems.push(
      `p-0! allowlist changed: ${p0.join(", ") || "no occurrences"}`
    );
  }

  return problems;
}

function utilityBody(css: string, name: string): string {
  const marker = `@utility ${name} {`;
  const starts = [
    ...css.matchAll(
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
    ),
  ];
  if (starts.length !== 1)
    throw new Error(`${name} must be declared exactly once`);
  const start = starts[0].index! + marker.length;
  return stripComments(css.slice(start, css.indexOf("}", start))).trim();
}

describe("delegated card gutter contract (#3507)", () => {
  it("owns the zero-padding premise and all horizontal values in shared utilities", () => {
    const css = fs.readFileSync(path.join(REPO, "app/globals.css"), "utf8");
    expect(utilityBody(css, "card-delegated")).toBe(
      "@apply overflow-hidden p-0!;"
    );
    expect(utilityBody(css, "card-gutter-standard")).toBe(
      "@apply px-4 sm:px-5;"
    );
    expect(utilityBody(css, "card-gutter-compact")).toBe(
      "@apply px-2 sm:px-5;"
    );
    expect(utilityBody(css, "card-gutter-action")).toBe("@apply px-2 sm:px-3;");
  });

  it("pins every parent and rendered gutter carrier, with no local overrides", () => {
    expect(contractProblems(REPO, ADOPTERS)).toEqual([]);
    expect(
      ADOPTERS.filter((entry) => entry.token === "card-delegated").reduce(
        (n, entry) => n + entry.count,
        0
      )
    ).toBeGreaterThanOrEqual(4);
  });

  function fixtureProblems(source: string, adopters: readonly Anchor[] = []) {
    const root = makeTmpDir("card-gutter");
    fs.mkdirSync(path.join(root, "app/(app)/protocols"), { recursive: true });
    fs.mkdirSync(path.join(root, "components"), { recursive: true });
    fs.writeFileSync(
      path.join(root, PROTOCOL_P0.file),
      `<button className="${PROTOCOL_P0.className}" />`
    );
    fs.writeFileSync(path.join(root, "components/Fixture.tsx"), source);
    return contractProblems(root, adopters, []);
  }

  function periodStatsProblems(source: string) {
    const root = makeTmpDir("card-gutter-period-stats");
    fs.mkdirSync(path.join(root, "app/(app)/protocols"), { recursive: true });
    fs.mkdirSync(path.join(root, "app/(app)/trends/metric/[kind]"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, PROTOCOL_P0.file),
      `<button className="${PROTOCOL_P0.className}" />`
    );
    fs.writeFileSync(
      path.join(root, "app/(app)/trends/metric/[kind]/page.tsx"),
      source
    );
    return contractProblems(
      root,
      ADOPTERS.filter((entry) => entry.site === "period-stats"),
      LAYOUTS.filter((entry) => entry.site === "period-stats")
    );
  }

  it("fails closed on the mutations that defeated the former expression scan", () => {
    const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
      [
        "a conditional utility branch",
        '<div className={menu ? "card-gutter-standard" : ""} />',
        /raw occurrence/,
      ],
      [
        "a five-deep hoisted parent",
        'const A="card card-delegated"; const B=A; const C=B; const D=C; const E=D; <section className={E} />',
        /raw occurrence/,
      ],
      [
        "an otherwise unrelated p-0 helper",
        'const ICON="p-0!"; <button className={cn(ICON)} />',
        /p-0! allowlist changed/,
      ],
      [
        "a newly hand-written p-0 card",
        '<section className="card overflow-hidden p-0!"><div /></section>',
        /p-0! allowlist changed/,
      ],
      [
        "an unregistered primitive adopter",
        '<section className="card card-delegated"><div /></section>',
        /registered tag/,
      ],
    ];
    for (const [name, source, expected] of cases) {
      expect(fixtureProblems(source).join("\n"), name).toMatch(expected);
    }
  });

  it("pins the utility to the rendered carrier and refuses later or logical overrides", () => {
    const parent: Anchor = {
      site: "fixture",
      file: "components/Fixture.tsx",
      needle: 'data-testid="parent"',
      count: 1,
      token: "card-delegated",
    };
    const carrier: Anchor = {
      site: "fixture",
      file: "components/Fixture.tsx",
      needle: 'data-testid="carrier"',
      count: 1,
      token: "card-gutter-standard",
      ownerNeedle: 'data-testid="parent"',
    };
    expect(
      fixtureProblems(
        '<><section data-testid="parent" className="card card-delegated"><Carrier className="card-gutter-standard" /></section><div data-testid="carrier" className="py-2" /></>',
        [parent, carrier]
      ).join("\n")
    ).toMatch(/is missing card-gutter-standard/);
    for (const override of ["md:px-8", "lg:ps-8", "xl:pe-8"]) {
      expect(
        fixtureProblems(
          `<section data-testid="parent" className="card card-delegated"><div data-testid="carrier" className="card-gutter-standard ${override}" /></section>`,
          [parent, carrier]
        ).join("\n")
      ).toMatch(/overrides its token/);
    }
    expect(
      fixtureProblems(
        '<><section data-testid="parent" className="card card-delegated"><div /></section><div data-testid="carrier" className="card-gutter-standard" /></>',
        [parent, carrier]
      ).join("\n")
    ).toMatch(/outside its .* card/);
    for (const wrapper of [
      '<div className="px-8">',
      '<div><div className="md:ps-8">',
    ]) {
      const closes = wrapper.startsWith("<div><div")
        ? "</div></div>"
        : "</div>";
      expect(
        fixtureProblems(
          `<section data-testid="parent" className="card card-delegated">${wrapper}<div data-testid="carrier" className="card-gutter-standard" />${closes}</section>`,
          [parent, carrier]
        ).join("\n")
      ).toMatch(/unregistered horizontal-padding carrier/);
    }
    expect(
      fixtureProblems(
        '<section data-testid="parent" className="card card-delegated"><div data-testid="carrier" className="card-gutter-standard"><span className="px-2.5" /></div></section>',
        [parent, carrier]
      )
    ).toEqual([]);
  });

  it("catches the exact live PeriodStatsCard carrier and wrapper regressions", () => {
    const live = fs.readFileSync(
      path.join(REPO, "app/(app)/trends/metric/[kind]/page.tsx"),
      "utf8"
    );
    expect(
      periodStatsProblems(
        live
          .replace(
            'className="card-gutter-standard py-4"',
            'className="px-4 py-4 sm:px-5"'
          )
          .replace('data-card-delegated-cell="period-stat"', "")
      ).join("\n")
    ).toMatch(/unregistered horizontal-padding carrier/);

    const header = openingTagSpansWith(
      live,
      'data-testid="metric-period-stats-header"'
    )[0];
    const [start, end] = elementRange(live, header);
    const wrapped = `${live.slice(0, start)}<div className="px-8">${live.slice(start, end)}</div>${live.slice(end)}`;
    expect(periodStatsProblems(wrapped).join("\n")).toMatch(
      /unregistered horizontal-padding carrier/
    );

    for (const [declaration, expression] of [
      ['const WRAP = "px-8";', "{WRAP}"],
      [
        'const WRAP = "px-8"; const wrapperClass = (value: string) => value;',
        "{wrapperClass(WRAP)}",
      ],
    ]) {
      const hidden = `${declaration}\n${live.slice(0, start)}<div className=${expression}>${live.slice(start, end)}</div>${live.slice(end)}`;
      expect(periodStatsProblems(hidden).join("\n")).toMatch(
        /unresolved className lies between/
      );
    }
  });

  it("requires every registered delegated parent to own a registered carrier", () => {
    const parent: Anchor = {
      site: "fixture",
      file: "components/Fixture.tsx",
      needle: 'data-testid="parent"',
      count: 1,
      token: "card-delegated",
    };
    expect(
      fixtureProblems(
        '<section data-testid="parent" className="card card-delegated"><div /></section>',
        [parent]
      ).join("\n")
    ).toMatch(/has no registered gutter carrier/);
  });

  it("keeps the exact ProtocolCompare icon exception quiet", () => {
    expect(fixtureProblems("export {};")).toEqual([]);
  });
});
