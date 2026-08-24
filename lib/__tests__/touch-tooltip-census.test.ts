import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const INTERACTIVE_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "summary",
  "textarea",
]);
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "link",
  "menuitem",
  "option",
  "radio",
  "slider",
  "switch",
  "tab",
]);
const CENSUSED_FILES = new Set([
  "app/(app)/immunizations/ScheduleGrid.tsx",
  "app/(app)/nutrition/SupplementsTab.tsx",
  "app/(app)/records/specialty/skin/SkinLesionList.tsx",
  "app/(app)/settings/family/FamilyManager.tsx",
  "app/(app)/training/activity/[id]/page.tsx",
  "components/AdherenceRefill.tsx",
  "components/ClinicalResultsTable.tsx",
  "components/CuratedSupplementSuggestions.tsx",
  "components/DaylightChip.tsx",
  "components/DiagnosisChips.tsx",
  "components/ExerciseDetailPanel.tsx",
  "components/SessionRecapView.tsx",
  "components/StarredResults.tsx",
  "components/StrengthExplorer.tsx",
  "components/activity-form/ImportedActivityDetails.tsx",
  "components/activity-form/StrengthSets.tsx",
]);

const VISUAL_DATA_TITLE =
  "pre-existing visualization/data-cell label; its touch reading contract belongs to that surface, outside the named #3375 census";
const FULL_VALUE_TITLE =
  "pre-existing full-value expansion for compact, truncated, or relative visible text; retained as explicit follow-up debt outside #3375";
const STATUS_DETAIL_TITLE =
  "pre-existing dynamic status detail supplementing a visible state; retained as explicit follow-up debt outside #3375";

interface Allowance {
  file: string;
  title: string;
  count: number;
  why: string;
}

// Every pre-existing dynamic noninteractive title outside the issue's named
// census is classified exactly by file, expression, and occurrence count. A new
// expression, a duplicate occurrence, or a stale entry fails; this is not a
// wildcard by file. Static explanations have no allowance at all.
const TITLE_ALLOWLIST: readonly Allowance[] = [
  {
    file: "app/(app)/nutrition/FoodLogBar.tsx",
    title:
      '`${mealCount} ${mealCount === 1 ? "serving" : "servings"} in ${activeSlot} ${activeDay.label.toLowerCase()}`',
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "app/(app)/nutrition/WeeklyHabits.tsx",
    title: "c.label",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/page.tsx",
    title: "age.title ?? undefined",
    count: 3,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "app/(app)/results/clinical-results/view/page.tsx",
    title: "r.derived_formula",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "app/(app)/results/imaging/ImagingStudyList.tsx",
    title: "doseSourceNote(dose)",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "app/(app)/settings/ActiveSessions.tsx",
    title: "s.userAgent ?? undefined",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "app/(app)/settings/ApiTokensSettings.tsx",
    title: "apiTokenScopeSummary(scope)",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "app/(app)/settings/notifications/NotificationPrefs.tsx",
    title: "`${c.label} — follows ${c.owner}`",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "app/(app)/settings/notifications/NotificationPrefs.tsx",
    title: "`${c.label} can’t deliver this button-only reminder.`",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "app/(app)/sleep/ConsistencyStrip.tsx",
    title: "clockRange(n, timeFormat)",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/sleep/SleepHero.tsx",
    title: "`${s.label} ${formatHm(stages[s.key])}`",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/training/CardioSection.tsx",
    title: "`${b.intensity}: ${formatMinutes(b.minutes)}`",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/training/CyclingOverviewDetails.tsx",
    title: "`${zone.name}: ${zone.percent}%`",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/training/CyclingOverviewDetails.tsx",
    title: "`Zone ${zone.zone}: ${zone.percent}%`",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/training/EnduranceDepthSuite.tsx",
    title: "`Zone ${index + 1}: ${minutes} min`",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/training/FitnessCheckView.tsx",
    title: "DOMAIN_LABEL[tile.domain] ?? tile.domain",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "app/(app)/training/FitnessZonesSection.tsx",
    title: "`${b.intensity}: ${formatMinutes(b.minutes)}`",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/training/StrengthStandardsLadder.tsx",
    title: "band",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/training/StrengthStandardsLadder.tsx",
    title:
      "`About 90 days ago: ${fmtWeight(placement.prior!.e1rmKg, weightUnit)}`",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "app/(app)/training/TrainingLogRow.tsx",
    title: "card.fault",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "app/(app)/training/activity/[id]/CyclingActivityDetail.tsx",
    title: "`Zone ${zone.zone}: ${zone.percent}%`",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "app/(app)/trends/CompareSection.tsx",
    title: '`Pearson r over ${paired} shared date${paired === 1 ? "" : "s"}`',
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "app/(app)/trends/NutritionSection.tsx",
    title:
      '`${w.label} · ${ w.rate == null ? "no goal tracked" : `${w.met} of ${w.applicable} goals met` }`',
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "components/AppVersion.tsx",
    title: "commitMessage ?? undefined",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/DayHistory.tsx",
    title: "item.meta?.label",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/DayHistory.tsx",
    title: "detail ?? undefined",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/DayHistory.tsx",
    title: "row.label",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/EditLockNotice.tsx",
    title: "consequence",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/FitnessPercentile.tsx",
    title: "`Compared with same-age, same-sex norms (${ctx.source})`",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/HouseholdCard.tsx",
    title: "`Weight ${label} since the previous reading`",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/HouseholdCard.tsx",
    title: "titleFull",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/ImportFeed.tsx",
    title:
      "`Document names “${v.patientName}”, which doesn’t match this profile.`",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/ImportFeed.tsx",
    title:
      '`${v.scrutiny} extracted ${v.scrutiny === 1 ? "row" : "rows"} the extractor was unsure about — open this import to review them first.`',
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/RelativeTime.tsx",
    title: "title",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/SidebarContent.tsx",
    title: "version.commitMessage ?? undefined",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/StatBox.tsx",
    title: "valueTitle",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/TrendMetricCharts.tsx",
    title: "asOf.title ?? undefined",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/TrendMiniCard.tsx",
    title: "title",
    count: 2,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/TrendsContextBar.tsx",
    title: "rangeLabel",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/WeeklyTargets.tsx",
    title: "title",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/activity/ActivityPartRows.tsx",
    title: "delta.title",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/activity/ActivitySummaryLine.tsx",
    title: "item.title",
    count: 2,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/activity-form/ActivityFormHeader.tsx",
    title: "blocker",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/dashboard/DashboardStandingCluster.tsx",
    title: "presentation.hoverNote",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/dashboard/RecentLabReadout.tsx",
    title: "age.title ?? undefined",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/illness/CareTrailBand.tsx",
    title: '`${bar.situation}${bar.ongoing ? " (ongoing)" : ""}`',
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "components/illness/CareTrailBand.tsx",
    title:
      '`Visit${m.type ? ` — ${m.type}` : ""}${ m.dayNumber != null ? ` (Day ${m.dayNumber})` : "" }`',
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "components/illness/CareTrailBand.tsx",
    title: '`${c.medName}${c.overhang ? " (continues past illness)" : ""}`',
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "components/illness/CareTrailBand.tsx",
    title: '`Visit${m.type ? ` — ${m.type}` : ""}`',
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "components/integrations/SyncTimestamp.tsx",
    title: "relativeOnly || clockOnly ? absolute : undefined",
    count: 1,
    why: FULL_VALUE_TITLE,
  },
  {
    file: "components/medications/AdherenceCalendar.tsx",
    title: "`${cell.date} · ${STATE_LABEL[cell.state]}`",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "components/medications/ScheduledDoseAction.tsx",
    title: 'pastDue ? "Past due — earlier today" : undefined',
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
  {
    file: "components/practices/PracticeHeatmap.tsx",
    title:
      'cell.outside ? undefined : `${cell.date} — ${cell.count} ${ cell.count === 1 ? "session" : "sessions" }`',
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "components/practices/PracticeTrends.tsx",
    title: "weekCellTitle(week, weekly)",
    count: 1,
    why: VISUAL_DATA_TITLE,
  },
  {
    file: "components/ui.tsx",
    title: "title || type",
    count: 1,
    why: STATUS_DETAIL_TITLE,
  },
];

interface Finding {
  file: string;
  line: number;
  tag: string;
  title: string;
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".tsx")) out.push(file);
    }
  };
  walk(path.join(root, "app"));
  walk(path.join(root, "components"));
  return out;
}

function nestedHelpFindings(root: string): string[] {
  const findings: string[] = [];
  for (const absolute of sourceFiles(root)) {
    const source = ts.createSourceFile(
      absolute,
      fs.readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const walk = (node: ts.Node, insideLink = false): void => {
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText(source);
        const nextInsideLink = insideLink || tag === "Link";
        if (
          insideLink &&
          (tag === "InfoTooltipIcon" || tag === "RefillBadge")
        ) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.openingElement.getStart(source)
          );
          findings.push(
            `${path.relative(root, absolute)}:${line + 1} nests ${tag} inside Link`
          );
        }
        for (const child of node.children) walk(child, nextInsideLink);
        return;
      }
      if (ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        if (
          insideLink &&
          (tag === "InfoTooltipIcon" || tag === "RefillBadge")
        ) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(source)
          );
          findings.push(
            `${path.relative(root, absolute)}:${line + 1} nests ${tag} inside Link`
          );
        }
        return;
      }
      ts.forEachChild(node, (child) => walk(child, insideLink));
    };
    walk(source);
  }
  return findings;
}

function attribute(
  opening: ts.JsxOpeningLikeElement,
  name: string,
  source: ts.SourceFile
): ts.JsxAttribute | null {
  for (const property of opening.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.name.getText(source) === name)
      return property;
  }
  return null;
}

function attributeValue(
  attribute: ts.JsxAttribute | null,
  source: ts.SourceFile
): string | null {
  const initializer = attribute?.initializer;
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return null;
  const expression = initializer.expression;
  return ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : expression.getText(source);
}

function hasStaticAttributeValue(attribute: ts.JsxAttribute): boolean {
  const initializer = attribute.initializer;
  if (!initializer || ts.isStringLiteral(initializer)) return true;
  return (
    ts.isJsxExpression(initializer) &&
    !!initializer.expression &&
    (ts.isStringLiteral(initializer.expression) ||
      ts.isNoSubstitutionTemplateLiteral(initializer.expression))
  );
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hiddenFromSight(
  opening: ts.JsxOpeningLikeElement,
  source: ts.SourceFile
): boolean {
  if (attribute(opening, "hidden", source)) return true;
  const ariaHidden = attribute(opening, "aria-hidden", source);
  if (ariaHidden && !hasStaticAttributeValue(ariaHidden)) return true;
  if (attributeValue(ariaHidden, source) === "true") return true;
  const classAttribute = attribute(opening, "className", source);
  if (classAttribute && !hasStaticAttributeValue(classAttribute)) return true;
  const className = attributeValue(classAttribute, source);
  if (!className) return false;
  const tokens = new Set(className.split(/\s+/));
  return (
    tokens.has("hidden") || tokens.has("sr-only") || tokens.has("invisible")
  );
}

function visibleStaticText(
  element: ts.JsxElement,
  source: ts.SourceFile
): string {
  const parts: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isJsxElement(node) && hiddenFromSight(node.openingElement, source))
      return;
    if (ts.isJsxSelfClosingElement(node) && hiddenFromSight(node, source))
      return;
    if (ts.isJsxText(node)) parts.push(node.text);
    else ts.forEachChild(node, walk);
  };
  for (const child of element.children) walk(child);
  return normalized(parts.join(" "));
}

function visibleExpressions(
  element: ts.JsxElement,
  source: ts.SourceFile
): string[] {
  const expressions: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isJsxElement(node) && hiddenFromSight(node.openingElement, source))
      return;
    if (ts.isJsxSelfClosingElement(node) && hiddenFromSight(node, source))
      return;
    if (ts.isJsxExpression(node) && node.expression)
      expressions.push(node.expression.getText(source));
    else ts.forEachChild(node, walk);
  };
  for (const child of element.children) walk(child);
  return expressions;
}

function staticTitleFindings(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const absolute of sourceFiles(root)) {
    const relative = path.relative(root, absolute);
    const text = fs.readFileSync(absolute, "utf8");
    const source = ts.createSourceFile(
      absolute,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const inspect = (
      opening: ts.JsxOpeningLikeElement,
      element: ts.JsxElement | null,
      insideSvg: boolean
    ) => {
      const tag = opening.tagName.getText(source);
      if (!/^[a-z]/.test(tag) || insideSvg || tag === "iframe") return;
      if (INTERACTIVE_TAGS.has(tag)) return;
      const role = attributeValue(attribute(opening, "role", source), source);
      if (role && INTERACTIVE_ROLES.has(role)) return;
      const titleAttribute = attribute(opening, "title", source);
      const title = attributeValue(titleAttribute, source);
      if (!title || !titleAttribute) return;
      const ariaLabel = attributeValue(
        attribute(opening, "aria-label", source),
        source
      );
      const visible = element ? visibleStaticText(element, source) : "";
      const expressions = element ? visibleExpressions(element, source) : [];
      if (
        (ariaLabel && normalized(ariaLabel) === normalized(title)) ||
        visible === normalized(title) ||
        expressions.includes(title)
      )
        return;
      const { line } = source.getLineAndCharacterOfPosition(
        titleAttribute.getStart(source)
      );
      findings.push({
        file: relative,
        line: line + 1,
        tag,
        title: normalized(title),
      });
    };
    const walk = (node: ts.Node, insideSvg = false): void => {
      if (ts.isJsxElement(node)) {
        const tag = node.openingElement.tagName.getText(source);
        const nextInsideSvg = insideSvg || tag === "svg";
        inspect(node.openingElement, node, nextInsideSvg);
        for (const child of node.children) walk(child, nextInsideSvg);
        return;
      }
      if (ts.isJsxSelfClosingElement(node)) {
        inspect(
          node,
          null,
          insideSvg || node.tagName.getText(source) === "svg"
        );
        return;
      }
      ts.forEachChild(node, (child) => walk(child, insideSvg));
    };
    walk(source);
  }
  return findings;
}

function unallowed(
  findings: readonly Finding[],
  allowlist: readonly Allowance[] = TITLE_ALLOWLIST
): string[] {
  const grouped = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = `${finding.file}\0${finding.title}`;
    const list = grouped.get(key) ?? [];
    list.push(finding);
    grouped.set(key, list);
  }
  const allowances = new Map(
    allowlist.map((item) => [`${item.file}\0${item.title}`, item])
  );
  const problems: string[] = [];
  for (const [key, group] of grouped) {
    const allowance = allowances.get(key);
    if (!allowance) {
      for (const finding of group)
        problems.push(
          `${finding.file}:${finding.line} <${finding.tag}> keeps “${finding.title}” behind hover`
        );
      continue;
    }
    if (!allowance.why.trim())
      problems.push(`${allowance.file}: title allowance has no justification`);
    if (group.length !== allowance.count)
      problems.push(
        `${allowance.file}: “${allowance.title}” occurs ${group.length} times; allowance pins ${allowance.count}`
      );
    allowances.delete(key);
  }
  for (const allowance of allowances.values())
    problems.push(
      `${allowance.file}: stale title allowance for “${allowance.title}”`
    );
  return problems;
}

function scheduleTriggerContracts(): string[] {
  const absolute = path.join(REPO, "app/(app)/immunizations/ScheduleGrid.tsx");
  const source = ts.createSourceFile(
    absolute,
    fs.readFileSync(absolute, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const contracts: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const testId = attributeValue(
        attribute(node, "data-testid", source),
        source
      );
      if (
        testId === "schedule-grid-vaccine-trigger" ||
        testId === "schedule-grid-dose-trigger"
      ) {
        const names = node.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((item) => item.name.getText(source));
        const click = attribute(node, "onClick", source)?.initializer?.getText(
          source
        );
        contracts.push(
          `${[node.tagName.getText(source), testId, ...names.sort()].join(":")}:handler=${normalized(click ?? "missing")}`
        );
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  return contracts;
}

describe("touch-reachable tooltip census (#3375)", () => {
  it("keeps the census and new literal explanations off noninteractive HTML", () => {
    expect(sourceFiles(REPO).length).toBeGreaterThan(400);
    for (const relative of CENSUSED_FILES)
      expect(fs.existsSync(path.join(REPO, relative)), relative).toBe(true);
    expect(unallowed(staticTitleFindings(REPO))).toEqual([]);
    expect(nestedHelpFindings(REPO)).toEqual([]);
    const allowanceKeys = TITLE_ALLOWLIST.map(
      (item) => `${item.file}\0${item.title}`
    );
    expect(new Set(allowanceKeys).size).toBe(allowanceKeys.length);
    expect(
      new Set(TITLE_ALLOWLIST.map((item) => item.file)).size
    ).toBeGreaterThan(20);
  });

  it("plants offenders in the scanned corpus without flagging deliberate peers", () => {
    const root = makeTmpDir("touch-tooltip-census");
    fs.mkdirSync(path.join(root, "components"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "components/DaylightChip.tsx"),
      `export function Fixture() {
        const dynamic = "Dynamic hover fact";
        return <>
          <span title="Only on hover">UV 7</span>
          <div title={dynamic}>?</div>
          <button title="Duplicate icon label" aria-label="Duplicate icon label">×</button>
          <span title="Visible explanation">Visible explanation</span>
          <span title="Hidden duplicate"><span className="hidden">Hidden duplicate</span></span>
          <span title="Screen-reader duplicate"><span className="sr-only">Screen-reader duplicate</span></span>
          <span title="Aria-hidden duplicate"><span aria-hidden="true">Aria-hidden duplicate</span></span>
          <svg><g title="Chart touch-scrubbing owns this"><path /></g></svg>
        </>;
      }`
    );
    expect(unallowed(staticTitleFindings(root), [])).toEqual([
      expect.stringContaining("<span> keeps “Only on hover” behind hover"),
      expect.stringContaining("<div> keeps “dynamic” behind hover"),
      expect.stringContaining("<span> keeps “Hidden duplicate” behind hover"),
      expect.stringContaining(
        "<span> keeps “Screen-reader duplicate” behind hover"
      ),
      expect.stringContaining(
        "<span> keeps “Aria-hidden duplicate” behind hover"
      ),
    ]);
    fs.writeFileSync(
      path.join(root, "components/Nested.tsx"),
      `export function Nested() {
        return <Link href="/next"><RefillBadge /><InfoTooltipIcon label="help" /></Link>;
      }`
    );
    expect(nestedHelpFindings(root)).toEqual([
      expect.stringContaining("nests RefillBadge inside Link"),
      expect.stringContaining("nests InfoTooltipIcon inside Link"),
    ]);
  });

  it("keeps both ScheduleGrid detail carriers keyboard- and tap-pinnable", () => {
    expect(scheduleTriggerContracts()).toEqual([
      expect.stringMatching(
        /^button:schedule-grid-vaccine-trigger:.*aria-expanded.*onClick.*onFocus.*handler=.*togglePinned/
      ),
      expect.stringMatching(
        /^button:schedule-grid-dose-trigger:.*aria-expanded.*onClick.*onFocus.*handler=.*togglePinned/
      ),
    ]);
    const schedule = fs.readFileSync(
      path.join(REPO, "app/(app)/immunizations/ScheduleGrid.tsx"),
      "utf8"
    );
    expect(schedule).toContain('data-pinned={pinnedTip ? "true" : undefined}');
    expect(schedule).toMatch(
      /event\.key !== "Escape"[\s\S]*setPinnedTip\(null\);[\s\S]*setHoverTip\(null\);[\s\S]*pinnedTip\.anchor\.focus\(\);/
    );
    expect(schedule).toContain('document.addEventListener("pointerdown"');
    expect(schedule).toContain("onMouseEnter");
    expect(schedule).toContain("onMouseMove");
  });
});
