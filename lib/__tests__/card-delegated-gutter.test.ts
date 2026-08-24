import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

const PROTOCOL_P0 = {
  file: "app/(app)/protocols/ProtocolCompare.tsx",
  className: "btn-ghost btn-sm h-8 w-8 p-0!",
};

function classToken(name: string): RegExp {
  return new RegExp(
    `(?<![\\w-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`
  );
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
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
          source: withoutComments(
            fs.readFileSync(path.join(root, file), "utf8")
          ),
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

function contractProblems(root: string, adopters: readonly Anchor[]): string[] {
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
  return css
    .slice(start, css.indexOf("}", start))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
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
    return contractProblems(root, adopters);
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
