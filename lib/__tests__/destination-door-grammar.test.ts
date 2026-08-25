import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditDestinationDoorSource,
  chevronOccurrences,
  chevronLines,
  componentRuntimeReferences,
  componentModuleReferences,
  identifierLines,
  jsxMountLines,
  jsxMountContractLines,
  jsxMountOwnerLines,
  testIdLines,
  testIdOwnerLines,
  type DestinationDoorContract,
  type DoorOwner,
  type ExactJsxProp,
} from "../destination-door-grammar";

// THE EXACT, WHOLE-TREE DESTINATION-DOOR CENSUS (#3502).
//
// Four renderers produce nine current mounts. The census walks every tracked
// source file the app can compile, authenticates every import path back to its
// target module, and compares exact (renderer, file, occurrence) registries.
// Aliases, wrappers, re-exports, dynamic loads, new files, and extra chevrons in
// an already-registered file therefore fail instead of falling outside six
// named files that happened to hold the original mounts.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

interface Source {
  file: string;
  source: string;
}

function sourceFiles(): Source[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((file) =>
      SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension))
    )
    .map((file) => ({
      file,
      source: fs.readFileSync(path.join(REPO, file), "utf8"),
    }));
}

const SOURCES = sourceFiles();

function read(file: string): string {
  const source = SOURCES.find((entry) => entry.file === file)?.source;
  if (source == null) throw new Error(`source census did not read ${file}`);
  return source;
}

function withoutSourceExtension(file: string): string {
  for (const extension of SOURCE_EXTENSIONS) {
    if (file.endsWith(extension)) return file.slice(0, -extension.length);
  }
  return file;
}

function resolvedModule(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/"))
    return withoutSourceExtension(path.posix.normalize(specifier.slice(2)));
  if (!specifier.startsWith(".")) return null;
  return withoutSourceExtension(
    path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
  );
}

const RENDERERS: ReadonlyArray<{
  file: string;
  contract: DestinationDoorContract;
}> = [
  {
    file: "components/intake/SharedSuppliesLink.tsx",
    contract: {
      rendererName: "SharedSuppliesLink",
      testId: "shared-supplies-link",
      targetOwner: "link",
      destinationExpression: "SUPPLIES_HREF",
      destinationBinding: "module",
      moduleBindings: [
        { name: "SUPPLIES_HREF", moduleName: "@/lib/hrefs" },
        { name: "sharedSuppliesLinkLabel", moduleName: "@/lib/refill" },
      ],
      linkAttributes: [
        "href",
        "data-testid",
        "title",
        "aria-label",
        "className",
      ],
      title: "Medicine cabinet",
      label: { kind: "expression", value: "label" },
      childShape: ["tag:IconArchive", "expr:label", "tag:IconChevronRight"],
      accessibleName: { kind: "aria-label", value: "accessibleName" },
      treatment: {
        owner: "link",
        className:
          "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm text-link",
        tokens: ["text-link", "gap-1"],
      },
      bindings: [
        { name: "label", expression: "sharedSuppliesLinkLabel(count)" },
        {
          name: "accessibleName",
          expression:
            'count > 0 ? `Medicine cabinet: ${label}` : "Medicine cabinet"',
        },
      ],
    },
  },
  {
    file: "components/intake/DoseLedgerLink.tsx",
    contract: {
      rendererName: "DoseLedgerLink",
      testId: "dose-ledger-link",
      targetOwner: "link",
      destinationExpression: "doseLedgerHref(kind)",
      destinationBinding: "module",
      moduleBindings: [{ name: "doseLedgerHref", moduleName: "@/lib/hrefs" }],
      linkAttributes: ["href", "data-testid", "title", "className"],
      title: "Dose history",
      label: { kind: "literal", value: "Dose history" },
      childShape: [
        "tag:IconHistory",
        "text:Dose history",
        "tag:IconChevronRight",
      ],
      accessibleName: { kind: "visible-label" },
      treatment: {
        owner: "link",
        className:
          "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm text-link",
        tokens: ["text-link", "gap-1"],
      },
    },
  },
  {
    file: "app/(app)/household/page.tsx",
    contract: {
      rendererName: "HouseholdPage",
      testId: "household-history-link",
      targetOwner: "link",
      destinationExpression: "EPISODES_HREF",
      destinationBinding: "module",
      moduleBindings: [{ name: "EPISODES_HREF", moduleName: "@/lib/hrefs" }],
      linkAttributes: ["href", "className", "data-testid"],
      visibleAncestorComponents: [
        { name: "PageHeader", moduleName: "@/components/ui" },
      ],
      label: { kind: "literal", value: "Illness episodes" },
      childShape: ["text:Illness episodes", "tag:IconChevronRight"],
      accessibleName: { kind: "visible-label" },
      treatment: {
        owner: "link",
        className:
          "inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-sm text-link",
        tokens: ["text-link", "gap-1"],
      },
    },
  },
  {
    file: "components/dashboard/DashboardStandingCluster.tsx",
    contract: {
      rendererName: "DashboardStandingCluster",
      rendererCallbackSources: ["SECTIONS", "families", "members"],
      testId: "standing-door",
      targetOwner: "decoration",
      destinationExpression: "presentation.href",
      moduleBindings: [
        { name: "trackedPageFor", moduleName: "@/lib/recent-pages" },
      ],
      linkAttributes: ["href", "title", "className"],
      label: { kind: "expression", value: "door" },
      childShape: ["expr:door", "tag:IconChevronRight"],
      accessibleName: { kind: "row-content", value: "content" },
      treatment: {
        owner: "door",
        className:
          "standing-door pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 bg-surface pl-3 text-xs font-medium whitespace-nowrap text-brand-700 dark:text-brand-400",
        tokens: ["standing-door", "gap-1"],
      },
      decorationHidden: true,
      bindings: [
        {
          name: "door",
          expression: "presentation.href ? doorLabel(presentation.href) : null",
        },
      ],
      returns: [
        {
          functionName: "doorLabel",
          expression: "trackedPageFor(href)?.label ?? null",
        },
      ],
    },
  },
];

const HOUSEHOLD_HEADER_OWNER: DoorOwner = {
  kind: "jsx-attribute",
  ownerTag: "PageHeader",
  attribute: "action",
  ownerModule: "@/components/ui",
  ownerImport: "named",
};

const MOUNTS: ReadonlyArray<{
  component: string;
  targetFile: string;
  file: string;
  count: number;
  props: readonly ExactJsxProp[];
  owner: string;
  ownerContract: DoorOwner;
}> = [
  {
    component: "SharedSuppliesLink",
    targetFile: "components/intake/SharedSuppliesLink.tsx",
    file: "app/(app)/household/page.tsx",
    count: 1,
    props: [
      {
        name: "count",
        kind: "expression",
        value: "countVisiblePools(profileIds)",
      },
    ],
    owner: "Household PageHeader.action — owner-approved paired doors (#3487)",
    ownerContract: HOUSEHOLD_HEADER_OWNER,
  },
  {
    component: "SharedSuppliesLink",
    targetFile: "components/intake/SharedSuppliesLink.tsx",
    file: "app/(app)/medications/MedicationBoard.tsx",
    count: 1,
    props: [{ name: "count", kind: "expression", value: "cabinetCount" }],
    owner: "Current medications card (#3479)",
    ownerContract: {
      kind: "ancestor-attribute",
      ownerTag: "CardGroup",
      attribute: "title",
      value: "Current medications",
      ownerModule: "@/components/CardGroup",
      ownerImport: "default",
    },
  },
  {
    component: "SharedSuppliesLink",
    targetFile: "components/intake/SharedSuppliesLink.tsx",
    file: "app/(app)/nutrition/SupplementsTab.tsx",
    count: 2,
    props: [{ name: "count", kind: "expression", value: "cabinetCount" }],
    owner: "both Supplements layouts' Manage sections",
    ownerContract: {
      kind: "ancestor-heading",
      ownerTag: "section",
      headingTag: "h2",
      text: "Manage",
    },
  },
  {
    component: "DoseLedgerLink",
    targetFile: "components/intake/DoseLedgerLink.tsx",
    file: "app/(app)/medications/MedicationsTodayPanel.tsx",
    count: 1,
    props: [{ name: "kind", kind: "literal", value: "medication" }],
    owner: "Medications Today card",
    ownerContract: {
      kind: "ancestor-attribute",
      ownerTag: "section",
      attribute: "data-testid",
      value: "medications-today",
    },
  },
  {
    component: "DoseLedgerLink",
    targetFile: "components/intake/DoseLedgerLink.tsx",
    file: "app/(app)/nutrition/SupplementsTab.tsx",
    count: 2,
    props: [{ name: "kind", kind: "literal", value: "supplement" }],
    owner: "both Supplements layouts' Manage sections",
    ownerContract: {
      kind: "ancestor-heading",
      ownerTag: "section",
      headingTag: "h2",
      text: "Manage",
    },
  },
  {
    component: "DashboardStandingCluster",
    targetFile: "components/dashboard/DashboardStandingCluster.tsx",
    file: "components/dashboard/DashboardPlacementCanvas.tsx",
    count: 1,
    props: [
      { name: "placements", kind: "expression", value: "standing" },
      {
        name: "presentations",
        kind: "expression",
        value: "standingPresentations",
      },
    ],
    owner: "the `standing.length > 0` Standing-lane branch",
    ownerContract: { kind: "logical-and", expression: "standing.length > 0" },
  },
];

const NON_DOOR_CHEVRON_FILES = new Map<string, { count: number; why: string }>([
  [
    "app/(app)/immunizations/MyChartImport.tsx",
    {
      count: 1,
      why: "the trailing mark inside a whole-card Import navigation",
    },
  ],
  [
    "app/(app)/protocols/ProtocolList.tsx",
    { count: 1, why: "the trailing mark on each protocol record row" },
  ],
  [
    "app/(app)/training/activity/[id]/ActivityDetailControls.tsx",
    { count: 1, why: "the Resume button's action cue" },
  ],
  [
    "app/(app)/training/activity/[id]/ActivityLedgerNav.tsx",
    { count: 1, why: "next-record pagination" },
  ],
  [
    "components/activity-form/ActivityMoreDetails.tsx",
    { count: 1, why: "a disclosure-state indicator" },
  ],
  [
    "components/dashboard/IllnessNowGroup.tsx",
    { count: 1, why: "a disclosure-state indicator" },
  ],
  [
    "components/integrations/SyncHistoryDays.tsx",
    { count: 1, why: "a disclosure-state indicator" },
  ],
  ["components/photo/PhotoGallery.tsx", { count: 1, why: "carousel next" }],
  [
    "components/AdherenceRefill.tsx",
    { count: 1, why: "the trailing mark on a refill detail row" },
  ],
  [
    "components/ClinicalResultsTable.tsx",
    { count: 1, why: "a row disclosure-state indicator" },
  ],
  ["components/DateField.tsx", { count: 1, why: "calendar next month" }],
  [
    "components/EquipmentManager.tsx",
    { count: 1, why: "the trailing mark on an equipment row" },
  ],
  [
    "components/HouseholdCard.tsx",
    { count: 1, why: "the trailing mark on a member card" },
  ],
  ["components/LeadFold.tsx", { count: 1, why: "lead-fold disclosure" }],
  ["components/Nav.tsx", { count: 1, why: "navigation-group disclosure" }],
  [
    "components/ProducedListing.tsx",
    { count: 1, why: "the trailing mark on an imported record row" },
  ],
  [
    "components/ProducedProviders.tsx",
    { count: 1, why: "the trailing mark on a provider row" },
  ],
  [
    "components/ProfileSwitcherChip.tsx",
    { count: 1, why: "the trailing mark on a profile switch row" },
  ],
  [
    "components/QuickLogSheet.tsx",
    { count: 1, why: "the trailing mark on a quick-log action row" },
  ],
  ["components/RawDataViewer.tsx", { count: 1, why: "tree disclosure" }],
  [
    "components/SessionComparisonChart.tsx",
    { count: 1, why: "the trailing mark on a comparison point" },
  ],
  ["components/TimelineDayNav.tsx", { count: 1, why: "next-day pagination" }],
  [
    "components/TrainingLogCalendar.tsx",
    { count: 1, why: "calendar next month" },
  ],
]);

// Exact structural identities for the non-door arrows. This is deliberately
// occurrence-level: moving an arrow into a different Link/button in the same
// registered file changes its owner, label/test identity, or accessibility.
const NON_DOOR_CHEVRON_SIGNATURES = new Map<string, readonly string[]>([
  [
    "app/(app)/immunizations/MyChartImport.tsx",
    ["Link[href:literal:/data?section=import]|aria-hidden:true"],
  ],
  [
    "app/(app)/protocols/ProtocolList.tsx",
    [
      'Link[href:expression:syntax:"`/protocols/${p.id}`",data-testid:expression:syntax:"`protocol-row-${p.id}`"]>li>ul[data-testid:literal:protocol-list]|aria-hidden:true',
    ],
  ],
  [
    "app/(app)/training/activity/[id]/ActivityDetailControls.tsx",
    [
      "button[data-testid:literal:session-in-progress,type:literal:button]|aria-hidden:true",
    ],
  ],
  [
    "app/(app)/training/activity/[id]/ActivityLedgerNav.tsx",
    [
      "PendingLink[href:expression:activityHref(newerId),testId:literal:activity-newer-link,label:literal:newer activity]>span>div[data-testid:literal:activity-ledger-navigation]|aria-hidden:true",
    ],
  ],
  [
    "components/activity-form/ActivityMoreDetails.tsx",
    [
      "button[type:literal:button,aria-expanded:expression:open]>section[data-testid:literal:activity-more-details]|aria-hidden:true",
    ],
  ],
  [
    "components/dashboard/IllnessNowGroup.tsx",
    [
      'button[data-testid:expression:syntax:"`illness-cockpit-toggle-${c.episodeKey}`",aria-label:expression:syntax:"lockedOpen\\n                    ? `${episodeLabel} details for ${c.displayName}`\\n                    : `${expanded ? \\"Collapse\\" : \\"Expand\\"} ${episodeLabel} details for ${c.displayName}`",type:literal:button,aria-expanded:expression:expanded]>div[data-testid:literal:illness-cockpit-header-row]>div[data-testid:expression:syntax:"`illness-cockpit-${c.episodeKey}`"]>section[data-testid:literal:illness-now-group,aria-label:literal:Illness]|aria-hidden:true',
    ],
  ],
  [
    "components/integrations/SyncHistoryDays.tsx",
    [
      'summary[data-testid:literal:sync-day-summary]>details[data-testid:expression:syntax:"`sync-day-${day.day}`"]>li>ul|aria-hidden:true',
    ],
  ],
  [
    "components/photo/PhotoGallery.tsx",
    [
      'button[data-testid:literal:photo-lightbox-next,aria-label:literal:Next photo,title:literal:Next photo,type:literal:button]>div>div[data-testid:literal:photo-lightbox,role:literal:dialog,aria-label:expression:syntax:"`Photo from ${open.date}`"]>div[data-testid:literal:photo-gallery]|aria-hidden:true',
    ],
  ],
  [
    "components/AdherenceRefill.tsx",
    [
      'Link[href:expression:SUPPLIES_HREF,data-testid:literal:shared-supply-chip,title:expression:syntax:"`Shared supply — ${bottleLabel(pool)}, drawn from by ${\\n        pool.memberCount\\n      } tracked item${pool.memberCount === 1 ? \\"\\" : \\"s\\"}`"]|aria-hidden:true',
    ],
  ],
  [
    "components/ClinicalResultsTable.tsx",
    [
      "button[data-testid:literal:clinical-result-panel-toggle,aria-label:expression:panelGroupSummary(group),type:literal:button,aria-expanded:expression:open]>Td>tr[data-testid:literal:clinical-result-panel-header]|aria-hidden:true",
    ],
  ],
  [
    "components/DateField.tsx",
    [
      "button[aria-label:literal:Next month,title:literal:Next month,type:literal:button]>div>div>AnchoredPanel[testId:literal:date-field-calendar,title:literal:Choose a date]>div|aria-hidden:true",
    ],
  ],
  [
    "components/EquipmentManager.tsx",
    [
      'Link[href:expression:syntax:"`/equipment/${e.id}`"]>div>div>li[data-testid:literal:equipment-row]|aria-hidden:true',
    ],
  ],
  [
    "components/HouseholdCard.tsx",
    [
      "button[data-testid:literal:household-open,type:literal:submit]>form>div[data-testid:literal:household-card]|aria-hidden:true",
    ],
  ],
  [
    "components/LeadFold.tsx",
    [
      'summary[data-testid:expression:syntax:"`${testId}-fold-summary`"]>details[data-testid:expression:syntax:"`${testId}-fold`"]>div[data-testid:expression:testId]|aria-hidden:true',
    ],
  ],
  [
    "components/Nav.tsx",
    [
      "button[type:literal:button,aria-expanded:expression:expanded]>div|aria-hidden:true",
    ],
  ],
  [
    "components/ProducedListing.tsx",
    [
      "Link[href:expression:item.href]>li[data-testid:literal:produced-item]>ul>div[data-testid:literal:produced-listing]|aria-hidden:true",
    ],
  ],
  [
    "components/ProducedProviders.tsx",
    [
      "Link[href:expression:p.href]>li[data-testid:literal:produced-provider]>ul>div[data-testid:literal:produced-providers]|aria-hidden:true",
    ],
  ],
  [
    "components/ProfileSwitcherChip.tsx",
    [
      'Link[href:expression:destination,data-testid:expression:testId,aria-label:expression:syntax:"`Open ${label} for ${profile.name}`"]||button[data-testid:expression:testId,aria-label:expression:syntax:"`Switch to ${profile.name} and open ${label}`",type:literal:submit]>form|aria-hidden:true',
    ],
  ],
  [
    "components/QuickLogSheet.tsx",
    [
      'button[data-testid:expression:syntax:"`quick-log-${item.id}`",type:literal:button]>li>ul[data-testid:literal:log-sheet-items]>LoggedViaSurface>BottomSheet[testId:literal:quick-log-sheet,title:literal:Log]|aria-hidden:true',
    ],
  ],
  [
    "components/RawDataViewer.tsx",
    [
      "button[data-testid:literal:raw-node-toggle,type:literal:button,aria-expanded:expression:open]>div|aria-hidden:true",
    ],
  ],
  [
    "components/SessionComparisonChart.tsx",
    [
      'Link[href:expression:point.href,data-testid:expression:syntax:"`${testIdPrefix}-link`",aria-label:expression:syntax:"`Open ${point.title} from ${formatLongDate(\\n                      point.date,\\n                      formatPrefs,\\n                      { year: \\"always\\" }\\n                    )}`"]>li[data-testid:expression:syntax:"`${testIdPrefix}-observation`"]>ol[aria-label:expression:syntax:"`${selected.label} across ${points.length} ${noun}`"]>div[data-testid:expression:syntax:"`${testIdPrefix}-ranking`"]>div[data-testid:expression:syntax:"`${testIdPrefix}-chart`"]|aria-hidden:true',
    ],
  ],
  [
    "components/TimelineDayNav.tsx",
    [
      "PendingLink[href:expression:nextHref,testId:literal:timeline-day-next,label:expression:nextLabel]>nav[data-testid:literal:timeline-day-nav,aria-label:literal:Adjacent days]|aria-hidden:true",
    ],
  ],
  [
    "components/TrainingLogCalendar.tsx",
    [
      "button[aria-label:literal:Next month,title:literal:Next month,type:literal:button]>div>div|aria-hidden:true",
    ],
  ],
]);

function chevronSignature(source: string): string[] {
  return chevronOccurrences(source).map(
    ({ ancestry, ariaHidden }) => `${ancestry}|aria-hidden:${ariaHidden}`
  );
}

function occurrenceMap(
  sources: readonly Source[],
  find: (source: string) => number[]
): Map<string, number> {
  const found = new Map<string, number>();
  for (const source of sources) {
    const count = find(source.source).length;
    if (count > 0) found.set(source.file, count);
  }
  return found;
}

function plainMap(map: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
  );
}

function expectedMountMap(component: string): Map<string, number> {
  return new Map(
    MOUNTS.filter((mount) => mount.component === component).map((mount) => [
      mount.file,
      mount.count,
    ])
  );
}

function moduleReferenceFindings(
  sources: readonly Source[],
  component: string,
  targetFile: string,
  expectedFiles: ReadonlyMap<string, number>
): string[] {
  const target = withoutSourceExtension(targetFile);
  const findings: string[] = [];
  const actualImportFiles = new Map<string, number>();
  for (const source of sources) {
    for (const reference of componentModuleReferences(
      source.source,
      component
    )) {
      const computed = reference.kind.startsWith("computed-");
      if (computed) {
        findings.push(
          `${source.file}:${reference.line} has unresolved ${reference.kind}`
        );
        continue;
      }
      if (resolvedModule(source.file, reference.moduleName) !== target)
        continue;
      if (reference.kind !== "import" || !reference.canonical) {
        findings.push(
          `${source.file}:${reference.line} reaches ${targetFile} through ` +
            `${reference.kind}${reference.local ? ` as ${reference.local}` : ""}`
        );
      } else {
        actualImportFiles.set(
          source.file,
          (actualImportFiles.get(source.file) ?? 0) + 1
        );
      }
    }
  }
  for (const [file, expectedMounts] of expectedFiles) {
    if (actualImportFiles.get(file) !== 1) {
      findings.push(
        `${file} has ${actualImportFiles.get(file) ?? 0} canonical imports of ${targetFile}; expected 1`
      );
    }
    const uses = componentRuntimeReferences(
      sources.find((source) => source.file === file)?.source ?? "",
      component
    );
    const jsx = uses.filter((use) => use.kind === "jsx");
    const nonJsx = uses.filter((use) => use.kind === "non-jsx");
    if (jsx.length !== expectedMounts) {
      findings.push(
        `${file} has ${jsx.length} direct JSX reference(s) to ${component}; expected ${expectedMounts}`
      );
    }
    for (const use of nonJsx) {
      findings.push(
        `${file}:${use.line} has a non-JSX reference to ${component}`
      );
    }
  }
  for (const [file, count] of actualImportFiles) {
    if (!expectedFiles.has(file)) {
      findings.push(
        `${file} has ${count} unregistered canonical import(s) of ${targetFile}`
      );
    }
  }
  return findings;
}

describe("destination-door grammar (#3502)", () => {
  it("reads the whole tracked source corpus", () => {
    expect(SOURCES.length).toBeGreaterThan(1_000);
    expect(SOURCES.some((source) => source.file.startsWith("app/"))).toBe(true);
    expect(
      SOURCES.some((source) => source.file.startsWith("components/"))
    ).toBe(true);
    expect(SOURCES.some((source) => source.file.startsWith("lib/"))).toBe(true);
  });

  it("keeps all four exact renderers on the destination/accessibility contract", () => {
    expect(RENDERERS).toHaveLength(4);
    const findings = RENDERERS.flatMap(({ file, contract }) =>
      auditDestinationDoorSource(read(file), contract).issues.map(
        (issue) => `${file}: ${issue}`
      )
    );
    expect(findings).toEqual([]);

    for (const renderer of RENDERERS) {
      const actual = occurrenceMap(SOURCES, (source) =>
        testIdLines(source, renderer.contract.testId)
      );
      expect(plainMap(actual)).toEqual({ [renderer.file]: 1 });
    }
  });

  it("finds exactly nine mounts globally and pins each owning surface", () => {
    const components = [...new Set(MOUNTS.map((mount) => mount.component))];
    let componentMounts = 0;
    for (const component of components) {
      const actual = occurrenceMap(SOURCES, (source) =>
        jsxMountLines(source, component)
      );
      const expected = expectedMountMap(component);
      expect(plainMap(actual), component).toEqual(plainMap(expected));
      componentMounts += [...actual.values()].reduce(
        (sum, count) => sum + count,
        0
      );

      const entry = MOUNTS.find((mount) => mount.component === component)!;
      expect(
        moduleReferenceFindings(SOURCES, component, entry.targetFile, expected),
        component
      ).toEqual([]);
    }

    for (const mount of MOUNTS) {
      expect(
        jsxMountContractLines(read(mount.file), mount.component, mount.props),
        `${mount.file}: exact ${mount.component} props`
      ).toHaveLength(mount.count);
      expect(
        jsxMountOwnerLines(
          read(mount.file),
          mount.component,
          mount.ownerContract
        ),
        `${mount.file}: ${mount.owner}`
      ).toHaveLength(mount.count);
    }

    const inlineHouseholdMounts = occurrenceMap(SOURCES, (source) =>
      testIdLines(source, "household-history-link")
    );
    expect(plainMap(inlineHouseholdMounts)).toEqual({
      "app/(app)/household/page.tsx": 1,
    });
    expect(
      testIdOwnerLines(
        read("app/(app)/household/page.tsx"),
        "household-history-link",
        HOUSEHOLD_HEADER_OWNER
      )
    ).toHaveLength(1);
    const inlineMountCount = [...inlineHouseholdMounts.values()].reduce(
      (sum, count) => sum + count,
      0
    );
    expect(componentMounts + inlineMountCount).toBe(9);
  });

  it("classifies every chevron by exact file and occurrence", () => {
    const actual = occurrenceMap(SOURCES, chevronLines);
    const identifierOccurrences = occurrenceMap(SOURCES, (source) =>
      identifierLines(source, "IconChevronRight")
    );
    const expected = new Map<string, number>();
    for (const renderer of RENDERERS) expected.set(renderer.file, 1);
    for (const [file, registration] of NON_DOOR_CHEVRON_FILES) {
      expect(registration.why.length).toBeGreaterThan(5);
      expected.set(file, registration.count);
    }
    expect(plainMap(actual)).toEqual(plainMap(expected));
    expect(plainMap(identifierOccurrences)).toEqual(
      plainMap(
        new Map(
          [...expected].map(([file, count]) => [
            file,
            count + 1, // one canonical named import + each exact JSX occurrence
          ])
        )
      )
    );
    expect(NON_DOOR_CHEVRON_SIGNATURES.size).toBe(NON_DOOR_CHEVRON_FILES.size);
    for (const [file, signatures] of NON_DOOR_CHEVRON_SIGNATURES) {
      expect(chevronSignature(read(file)), file).toEqual(signatures);
      expect(
        chevronOccurrences(read(file)).flatMap(
          (occurrence) => occurrence.issues
        ),
        file
      ).toEqual([]);
      expect(
        chevronOccurrences(read(file)).every(
          (occurrence) => occurrence.ariaHidden === "true"
        ),
        `${file}: non-door chevrons are decorative`
      ).toBe(true);
    }
  });
});

describe("the destination-door reader's reach", () => {
  const contract: DestinationDoorContract = {
    rendererName: "Door",
    testId: "door",
    targetOwner: "link",
    destinationExpression: "DESTINATION",
    destinationBinding: "module",
    moduleBindings: [{ name: "DESTINATION", moduleName: "@/dest" }],
    linkAttributes: ["href", "data-testid", "className"],
    label: { kind: "expression", value: "identity" },
    childShape: ["expr:identity", "tag:IconChevronRight"],
    accessibleName: { kind: "visible-label" },
    treatment: {
      owner: "link",
      className: "text-link gap-1",
      tokens: ["text-link", "gap-1"],
    },
    bindings: [{ name: "identity", expression: "identityOf(destination)" }],
  };
  const good = `
    import Link from "next/link";
    import { IconChevronRight } from "@tabler/icons-react";
    import { DESTINATION } from "@/dest";
    export default function Door() {
      const identity = identityOf(destination);
      return <Link href={DESTINATION} data-testid="door" className="text-link gap-1">
        {identity}
        <IconChevronRight aria-hidden className="h-4 w-4" />
      </Link>;
    }
  `;

  it.each([
    ["destination", good.replace("href={DESTINATION}", "href={OTHER}")],
    ["label", good.replace("{identity}", "Other")],
    ["label", good.replace("{identity}", "Destination now")],
    ["label", good.replace("{identity}", "<span>{identity}</span>")],
    [
      "content-shape",
      good.replace("<IconChevronRight", "<span>Other</span><IconChevronRight"),
    ],
    ["treatment", good.replace("text-link gap-1", "gap-1")],
    [
      "dynamic-treatment",
      good.replace(
        'className="text-link gap-1"',
        'className={active ? "text-link gap-1" : "gap-1"}'
      ),
    ],
    ["link-spread-attributes", good.replace("href=", "{...props} href=")],
    [
      "link-duplicate-attribute:href",
      good.replace("href=", "href={OTHER} href="),
    ],
    ["chevron-count:0", good.replace(/<IconChevronRight[^>]+\/>/, "")],
    [
      "chevron-count:2",
      good.replace("</Link>", "<IconChevronRight aria-hidden />\n</Link>"),
    ],
    [
      "chevron-accessibility",
      good.replace("aria-hidden className", "className"),
    ],
    [
      "chevron-spread-attributes",
      good.replace(
        "aria-hidden className",
        "aria-hidden {...chevronProps} className"
      ),
    ],
    [
      "chevron-duplicate-attribute:aria-hidden",
      good.replace(
        "aria-hidden className",
        'aria-hidden aria-hidden="false" className'
      ),
    ],
    ["retired-arrow-glyph", good.replace("{identity}", "{identity} →")],
    [
      "binding:identity",
      good.replace("identityOf(destination)", "String(destination)"),
    ],
    ["link-import", good.replace("import Link", "import NextLink")],
    [
      "chevron-import",
      good.replace("{ IconChevronRight }", "{ IconChevronRight as Chevron }"),
    ],
    [
      "accessible-name-override",
      good.replace(
        'data-testid="door"',
        'data-testid="door" aria-label="Other"'
      ),
    ],
    [
      "hidden-link",
      good.replace('data-testid="door"', 'data-testid="door" aria-hidden'),
    ],
    [
      "hidden-link-dynamic",
      good.replace(
        'data-testid="door"',
        'data-testid="door" aria-hidden={hidden}'
      ),
    ],
    [
      "hidden-ancestry",
      good
        .replace("<Link", "<div aria-hidden><Link")
        .replace("</Link>", "</Link></div>"),
    ],
    [
      "hidden-ancestry-spread",
      good
        .replace("<Link", "<div {...ancestorProps}><Link")
        .replace("</Link>", "</Link></div>"),
    ],
    [
      "hidden-ancestry-dynamic",
      good
        .replace("<Link", "<div aria-hidden={hidden}><Link")
        .replace("</Link>", "</Link></div>"),
    ],
    [
      "link-aria-labelledby",
      good.replace(
        'data-testid="door"',
        'data-testid="door" aria-labelledby="other"'
      ),
    ],
    [
      "link-hidden",
      good.replace('data-testid="door"', 'data-testid="door" hidden'),
    ],
    [
      "link-inert",
      good.replace('data-testid="door"', 'data-testid="door" inert'),
    ],
    [
      "link-style",
      good.replace(
        'data-testid="door"',
        'data-testid="door" style={{ display: "none" }}'
      ),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 hidden"),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 opacity-0"),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 sr-only"),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 max-h-0"),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 [display:none]"),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 sm:!opacity-0"),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 [visibility:hidden]"),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 hidden!"),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 opacity-0!"),
    ],
    [
      "link-hidden-class",
      good.replace(
        "text-link gap-1",
        "text-link gap-1 [display:none!important]"
      ),
    ],
    [
      "link-hidden-class",
      good.replace("text-link gap-1", "text-link gap-1 [display:_none]"),
    ],
    [
      "hidden-ancestry-hidden",
      good
        .replace("<Link", "<div hidden><Link")
        .replace("</Link>", "</Link></div>"),
    ],
    [
      "hidden-ancestry-inert",
      good
        .replace("<Link", "<div inert><Link")
        .replace("</Link>", "</Link></div>"),
    ],
    [
      "hidden-ancestry-style",
      good
        .replace("<Link", '<div style={{ display: "none" }}><Link')
        .replace("</Link>", "</Link></div>"),
    ],
    [
      "hidden-ancestry-hidden-class",
      good
        .replace("<Link", '<div className="opacity-0"><Link')
        .replace("</Link>", "</Link></div>"),
    ],
    [
      "hidden-ancestry-dynamic-class",
      good
        .replace("<Link", "<div className={maybeHidden}><Link")
        .replace("</Link>", "</Link></div>"),
    ],
    [
      "hidden-ancestry-unsupported-component:Invisible",
      good
        .replace("<Link", "<Invisible><Link")
        .replace("</Link>", "</Link></Invisible>"),
    ],
    [
      "hidden-ancestry-template",
      good
        .replace("<Link", "<template><Link")
        .replace("</Link>", "</Link></template>"),
    ],
    [
      "hidden-ancestry-closed-dialog",
      good
        .replace("<Link", "<dialog><Link")
        .replace("</Link>", "</Link></dialog>"),
    ],
    [
      "hidden-ancestry-closed-details",
      good
        .replace("<Link", "<details><Link")
        .replace("</Link>", "</Link></details>"),
    ],
    [
      "link-shadow",
      good.replace("function Door()", "function Door(Link: unknown)"),
    ],
    [
      "chevron-shadow",
      good.replace(
        "function Door()",
        "function Door(IconChevronRight: unknown)"
      ),
    ],
    [
      "destination-shadow:DESTINATION",
      good.replace(
        "const identity = identityOf(destination);",
        "const DESTINATION = OTHER;\n      const identity = identityOf(destination);"
      ),
    ],
  ])("sees %s", (issue, source) => {
    expect(auditDestinationDoorSource(source, contract).issues).toContain(
      issue
    );
  });

  it("binds the target to the default renderer's supported live return", () => {
    const link = `<Link href={DESTINATION} data-testid="door" className="text-link gap-1">
      {identity}<IconChevronRight aria-hidden className="h-4 w-4" />
    </Link>`;
    const decoy =
      good.replace('data-testid="door"', 'data-testid="other"') +
      `\nfunction Decoy() { const identity = identityOf(destination); return ${link}; }`;
    expect(auditDestinationDoorSource(decoy, contract).issues).toContain(
      "renderer-scope"
    );
    expect(
      auditDestinationDoorSource(
        good.replace("return <Link", "return false && <Link"),
        contract
      ).issues
    ).toContain("renderer-dead-branch");
    expect(
      auditDestinationDoorSource(
        good.replace("return <Link", "if (false) return <Link"),
        contract
      ).issues
    ).toContain("renderer-dead-branch");
    for (const exit of [
      'if (kind === "medication") return null;',
      "if (true) return null;",
      'throw new Error("stop");',
    ]) {
      expect(
        auditDestinationDoorSource(
          good.replace("return <Link", `${exit}\n      return <Link`),
          contract
        ).issues,
        exit
      ).toContain("renderer-pre-return");
    }
    for (const dead of [
      "const SHOW = false;\n      return SHOW && <Link",
      "return 1 === 2 && <Link",
    ]) {
      expect(
        auditDestinationDoorSource(good.replace("return <Link", dead), contract)
          .issues,
        dead
      ).toContain("renderer-dead-branch");
    }
    expect(
      auditDestinationDoorSource(
        good
          .replace("return <Link", "return render(() => <Link")
          .replace("</Link>;", "</Link>);"),
        contract
      ).issues
    ).toContain("renderer-unsupported-callback");
    for (const callback of [
      "[].map(() => <Link",
      "custom.map(() => <Link",
      "items.map(realRenderer, () => <Link",
    ]) {
      expect(
        auditDestinationDoorSource(
          good
            .replace("return <Link", `return ${callback}`)
            .replace("</Link>;", "</Link>);"),
          contract
        ).issues,
        callback
      ).toContain("renderer-unsupported-callback");
    }
    expect(
      auditDestinationDoorSource(
        good.replace("return <Link", "return null;\n      return <Link"),
        contract
      ).issues
    ).toContain("renderer-pre-return");
    expect(
      auditDestinationDoorSource(
        good.replace("export default function Door", "function Door"),
        contract
      ).issues
    ).toContain("renderer-default-export");
  });

  it("pins Standing's hidden decoration, row content, identity call, and spacing", () => {
    const renderer = RENDERERS.find(
      (entry) => entry.contract.testId === "standing-door"
    )!;
    const source = read(renderer.file);
    expect(
      auditDestinationDoorSource(
        source.replace('aria-hidden="true"', 'aria-hidden="false"'),
        renderer.contract
      ).issues
    ).toContain("decoration-accessibility");
    expect(
      auditDestinationDoorSource(
        source.replace("{content}", "<span>{content}</span>"),
        renderer.contract
      ).issues
    ).toContain("accessible-name");
    expect(
      auditDestinationDoorSource(
        source.replace(
          "doorLabel(presentation.href)",
          "String(presentation.href)"
        ),
        renderer.contract
      ).issues
    ).toContain("binding:door");
    expect(
      auditDestinationDoorSource(
        source.replace("trackedPageFor(href)?.label", "String(href)"),
        renderer.contract
      ).issues
    ).toContain("return:doorLabel");
    expect(
      auditDestinationDoorSource(
        source.replace("items-center gap-1", "items-center"),
        renderer.contract
      ).issues
    ).toContain("treatment");
  });

  it("pins route and identity helpers to their canonical module symbols", () => {
    const shared = RENDERERS.find(
      (entry) => entry.contract.testId === "shared-supplies-link"
    )!;
    const source = read(shared.file);
    expect(
      auditDestinationDoorSource(
        source.replace(
          'import { SUPPLIES_HREF } from "@/lib/hrefs"',
          'import { OTHER as SUPPLIES_HREF } from "@/lib/hrefs"'
        ),
        shared.contract
      ).issues
    ).toContain("module-binding:SUPPLIES_HREF");
    expect(
      auditDestinationDoorSource(
        source.replace(
          "const label = sharedSuppliesLinkLabel(count);",
          "const SUPPLIES_HREF = OTHER;\n  const label = sharedSuppliesLinkLabel(count);"
        ),
        shared.contract
      ).issues
    ).toContain("module-binding-shadow:SUPPLIES_HREF");
    expect(
      auditDestinationDoorSource(
        source.replace(
          'from "@/lib/refill"',
          'from "@/lib/not-the-refill-model"'
        ),
        shared.contract
      ).issues
    ).toContain("module-binding:sharedSuppliesLinkLabel");
    expect(
      auditDestinationDoorSource(
        source.replace("href={SUPPLIES_HREF}", 'href="SUPPLIES_HREF"'),
        shared.contract
      ).issues
    ).toContain("destination");
    expect(
      auditDestinationDoorSource(
        source.replace(
          "aria-label={accessibleName}",
          'aria-label="accessibleName"'
        ),
        shared.contract
      ).issues
    ).toContain("accessible-name");
  });

  it("pins immutable destination inputs and forbids Link interaction overrides", () => {
    const dose = RENDERERS.find(
      (entry) => entry.contract.testId === "dose-ledger-link"
    )!;
    expect(
      auditDestinationDoorSource(
        read(dose.file).replace("return (", 'kind = "supplement";\n  return ('),
        dose.contract
      ).issues
    ).toContain("destination-input:kind");
    const standing = RENDERERS.find(
      (entry) => entry.contract.testId === "standing-door"
    )!;
    expect(
      auditDestinationDoorSource(
        read(standing.file).replace(
          "const door = presentation.href",
          "presentation.href = other;\n                            const door = presentation.href"
        ),
        standing.contract
      ).issues
    ).toContain("destination-input:presentation");
    for (const mutation of [
      "({ href: presentation.href } = other);",
      "for (presentation.href of hrefs) {}",
      "for (presentation.href in hrefs) {}",
      "delete presentation.href;",
      "Object.assign(presentation, { href: other });",
      'Reflect.set(presentation, "href", other);',
      "mutate(presentation);",
      "presentation.mutate();",
      "const escapedPresentation = presentation;",
    ]) {
      expect(
        auditDestinationDoorSource(
          read(standing.file).replace(
            "const door = presentation.href",
            `${mutation}\n                            const door = presentation.href`
          ),
          standing.contract
        ).issues,
        mutation
      ).toContain("destination-input:presentation");
    }

    for (const override of [
      "onClick={handleClick}",
      "replace",
      'role="button"',
      "tabIndex={-1}",
    ]) {
      expect(
        auditDestinationDoorSource(
          good.replace('data-testid="door"', `data-testid="door" ${override}`),
          contract
        ).issues,
        override
      ).toContain("link-attribute-contract");
    }
    expect(
      auditDestinationDoorSource(
        good
          .replace("return <Link", "return <button><Link")
          .replace("</Link>;", "</Link></button>;"),
        contract
      ).issues
    ).toContain("interactive-ancestry");
  });

  it("pins Household's inline door inside PageHeader.action", () => {
    const withHeader = (source: string) =>
      `import { PageHeader } from "@/components/ui"; ${source}`;
    const housed = `
      <PageHeader action={<Link data-testid="household-history-link" />} />
    `;
    expect(
      testIdOwnerLines(
        withHeader(housed),
        "household-history-link",
        HOUSEHOLD_HEADER_OWNER
      )
    ).toHaveLength(1);
    expect(
      testIdOwnerLines(
        withHeader(
          '<PageHeader action={<Other />} /><Link data-testid="household-history-link" />'
        ),
        "household-history-link",
        HOUSEHOLD_HEADER_OWNER
      )
    ).toEqual([]);
    for (const rejected of [
      '<PageHeader action={<Link data-testid="household-history-link" />} {...props} />',
      '<PageHeader action={<Link data-testid="household-history-link" />} action={<Other />} />',
      '<PageHeader action={active ? <Link data-testid="household-history-link" /> : null} />',
      '<PageHeader action={false && <Link data-testid="household-history-link" />} />',
      '<PageHeader action={() => <Link data-testid="household-history-link" />} />',
      '<PageHeader action={<div hidden><Link data-testid="household-history-link" /></div>} />',
      '<PageHeader action={<div className={maybeHidden}><Link data-testid="household-history-link" /></div>} />',
    ]) {
      expect(
        testIdOwnerLines(
          withHeader(rejected),
          "household-history-link",
          HOUSEHOLD_HEADER_OWNER
        )
      ).toEqual([]);
    }
    for (const untrusted of [
      'import { PageHeader } from "@/other"; <PageHeader action={<Link data-testid="household-history-link" />} />',
      'import { PageHeader } from "@/components/ui"; function Wrap(PageHeader: unknown) { return <PageHeader action={<Link data-testid="household-history-link" />} />; }',
    ]) {
      expect(
        testIdOwnerLines(
          untrusted,
          "household-history-link",
          HOUSEHOLD_HEADER_OWNER
        )
      ).toEqual([]);
    }
    const household = RENDERERS.find(
      (entry) => entry.contract.testId === "household-history-link"
    )!;
    expect(
      auditDestinationDoorSource(
        read(household.file).replace(
          'from "@/components/ui"',
          'from "@/components/other-ui"'
        ),
        household.contract
      ).issues
    ).toContain("hidden-ancestry-unsupported-component:PageHeader");
  });

  it("rejects spread owners and statically dead owner branches", () => {
    const medication = MOUNTS.find((mount) =>
      mount.file.endsWith("MedicationBoard.tsx")
    )!;
    expect(
      jsxMountOwnerLines(
        read(medication.file).replace(
          '<CardGroup\n        title="Current medications"',
          '<CardGroup\n        {...ownerProps}\n        title="Current medications"'
        ),
        medication.component,
        medication.ownerContract
      )
    ).toEqual([]);
    for (const source of [
      'import CardGroup from "@/components/CardGroup"; <div hidden><CardGroup title="Current medications"><SharedSuppliesLink count={cabinetCount} /></CardGroup></div>',
      'import CardGroup from "@/components/CardGroup"; {false && <CardGroup title="Current medications"><SharedSuppliesLink count={cabinetCount} /></CardGroup>}',
      'import CardGroup from "@/other"; <CardGroup title="Current medications"><SharedSuppliesLink count={cabinetCount} /></CardGroup>',
      'import CardGroup from "@/components/CardGroup"; function Wrap(CardGroup: unknown) { return <CardGroup title="Current medications"><SharedSuppliesLink count={cabinetCount} /></CardGroup>; }',
    ]) {
      expect(
        jsxMountOwnerLines(
          source,
          medication.component,
          medication.ownerContract
        )
      ).toEqual([]);
    }
    const headingOwner: DoorOwner = {
      kind: "ancestor-heading",
      ownerTag: "section",
      headingTag: "h2",
      text: "Manage",
    };
    for (const source of [
      "<section {...props}><h2>Manage</h2><Door /></section>",
      '<section className="a" className="b"><h2>Manage</h2><Door /></section>',
    ]) {
      expect(jsxMountOwnerLines(source, "Door", headingOwner)).toEqual([]);
    }
    expect(
      jsxMountOwnerLines(
        read(medication.file).replace(
          "{isActing ? (\n          <div",
          "{false && (\n          <div"
        ),
        medication.component,
        medication.ownerContract
      )
    ).toEqual([]);
    for (const dead of ["false", "0", '""']) {
      expect(
        jsxMountOwnerLines(
          read(medication.file).replace(
            "{isActing ? (\n          <div",
            `{${dead} && (\n          <div`
          ),
          medication.component,
          medication.ownerContract
        )
      ).toEqual([]);
    }
    const standing = MOUNTS.find(
      (mount) => mount.component === "DashboardStandingCluster"
    )!;
    expect(
      jsxMountOwnerLines(
        "{standing.length > 0 && (true || <DashboardStandingCluster />)}",
        standing.component,
        standing.ownerContract
      )
    ).toEqual([]);
  });

  it("pins exact mount props and rejects every statically dead wrapper", () => {
    const mount = MOUNTS.find(
      (entry) => entry.component === "DashboardStandingCluster"
    )!;
    const source = read(mount.file);
    for (const mutated of [
      source.replace(
        "placements={standing}",
        "{...props} placements={standing}"
      ),
      source.replace(
        "placements={standing}",
        "placements={other} placements={standing}"
      ),
      source.replace("placements={standing}", "placements={other}"),
      source.replace(
        "presentations={standingPresentations}",
        'presentations="standingPresentations"'
      ),
    ]) {
      expect(
        jsxMountContractLines(mutated, mount.component, mount.props)
      ).toEqual([]);
    }

    for (const dead of [
      "undefined",
      "void 0",
      "NaN",
      "!true",
      "false as boolean",
    ]) {
      expect(
        jsxMountOwnerLines(
          `{standing.length > 0 && (${dead} && <DashboardStandingCluster placements={standing} presentations={standingPresentations} />)}`,
          mount.component,
          mount.ownerContract
        ),
        dead
      ).toEqual([]);
    }
    expect(
      jsxMountOwnerLines(
        "{standing.length > 0 && (maybe() && <DashboardStandingCluster placements={standing} presentations={standingPresentations} />)}",
        mount.component,
        mount.ownerContract
      )
    ).toEqual([]);
  });

  it("binds the governed test id and label to the exact target node", () => {
    const nested = good.replace(
      'data-testid="door" className="text-link gap-1">',
      'className="text-link gap-1"><span data-testid="door">Wrong</span>'
    );
    const issues = auditDestinationDoorSource(nested, contract).issues;
    expect(issues).toContain("label");
    expect(issues).toContain("content-shape");

    const dose = RENDERERS.find(
      (entry) => entry.contract.testId === "dose-ledger-link"
    )!;
    const transplanted = read(dose.file)
      .replace('data-testid="dose-ledger-link"', "")
      .replace(
        "<IconHistory",
        '<span data-testid="dose-ledger-link"><IconHistory'
      )
      .replace("</Link>", "</span>Wrong sibling</Link>");
    const doseIssues = auditDestinationDoorSource(
      transplanted,
      dose.contract
    ).issues;
    expect(doseIssues).toContain("target-relationship");
    expect(doseIssues).toContain("accessible-name");
  });

  it("rejects aliases, wrappers, re-exports, dynamic loads, and requires", () => {
    const target = "components/intake/SharedSuppliesLink.tsx";
    const synthetic: Source[] = [
      {
        file: "app/a.tsx",
        source:
          'import Cabinet from "@/components/intake/SharedSuppliesLink"; <Cabinet />',
      },
      {
        file: "components/CabinetDoor.tsx",
        source:
          'import SharedSuppliesLink from "./intake/SharedSuppliesLink"; export default () => <SharedSuppliesLink />',
      },
      {
        file: "components/doors.ts",
        source: 'export { default } from "./intake/SharedSuppliesLink"',
      },
      {
        file: "app/dynamic.ts",
        source: 'const Door = import("@/components/intake/SharedSuppliesLink")',
      },
      {
        file: "app/required.cjs",
        source:
          'const Door = require("@/components/intake/SharedSuppliesLink")',
      },
    ];
    const findings = moduleReferenceFindings(
      synthetic,
      "SharedSuppliesLink",
      target,
      new Map()
    );
    expect(findings).toHaveLength(5);
    expect(findings.join("\n")).toMatch(/import as Cabinet/);
    expect(findings.join("\n")).toMatch(/re-export/);
    expect(findings.join("\n")).toMatch(/dynamic-import/);
    expect(findings.join("\n")).toMatch(/require/);

    const templateFindings = moduleReferenceFindings(
      [
        {
          file: "lib/ui/Cabinet.tsx",
          source:
            'const A = import(`@/components/intake/SharedSuppliesLink`); const B = require(`@/components/intake/SharedSuppliesLink`); const C = import(`@/components/intake/${"SharedSuppliesLink"}`); const D = require("@/components/intake/" + "SharedSuppliesLink"); const E = import(`@/components/intake/${candidate}`); const F = require("@/components/intake/" + candidate)',
        },
      ],
      "SharedSuppliesLink",
      target,
      new Map()
    );
    expect(templateFindings.join("\n")).toMatch(/dynamic-import/);
    expect(templateFindings.join("\n")).toMatch(/require/);
    expect(templateFindings.join("\n")).toMatch(/computed-dynamic-import/);
    expect(templateFindings.join("\n")).toMatch(/computed-require/);
    for (const source of [
      'const load = require; load("@/components/intake/SharedSuppliesLink")',
      'module.require("@/components/intake/SharedSuppliesLink")',
      'require.call(null, "@/components/intake/SharedSuppliesLink")',
      '(0, require)("@/components/intake/SharedSuppliesLink")',
      'const load = module.require; load("@/components/intake/SharedSuppliesLink")',
      'import Alias = require("@/components/intake/SharedSuppliesLink")',
    ]) {
      expect(
        moduleReferenceFindings(
          [{ file: "app/loader.ts", source }],
          "SharedSuppliesLink",
          target,
          new Map()
        ).join("\n"),
        source
      ).toMatch(/require/);
    }
    expect(
      moduleReferenceFindings(
        [
          {
            file: "app/normalized.tsx",
            source:
              'import SharedSuppliesLink from "@/components/other/../intake/SharedSuppliesLink"; <SharedSuppliesLink />',
          },
        ],
        "SharedSuppliesLink",
        target,
        new Map()
      ).length
    ).toBeGreaterThan(0);
    expect(
      moduleReferenceFindings(
        [
          {
            file: "app/unresolved.ts",
            source: "const module = import(runtimePath)",
          },
        ],
        "SharedSuppliesLink",
        target,
        new Map()
      ).join("\n")
    ).toMatch(/unresolved computed-dynamic-import/);
  });

  it.each([
    [
      "same-file alias",
      'import SharedSuppliesLink from "@/components/intake/SharedSuppliesLink"; const Cabinet = SharedSuppliesLink; <Cabinet />',
    ],
    [
      "createElement",
      'import SharedSuppliesLink from "@/components/intake/SharedSuppliesLink"; React.createElement(SharedSuppliesLink)',
    ],
    [
      "direct call",
      'import SharedSuppliesLink from "@/components/intake/SharedSuppliesLink"; SharedSuppliesLink({ count: 1 })',
    ],
    [
      "shadowed mount",
      'import SharedSuppliesLink from "@/components/intake/SharedSuppliesLink"; function View(SharedSuppliesLink: any) { return <SharedSuppliesLink /> }',
    ],
  ])("rejects %s component references", (_name, source) => {
    const findings = moduleReferenceFindings(
      [{ file: "app/a.tsx", source }],
      "SharedSuppliesLink",
      "components/intake/SharedSuppliesLink.tsx",
      new Map([["app/a.tsx", 1]])
    );
    expect(findings.length).toBeGreaterThan(0);
  });

  it("catches a lib wrapper even when an app consumes only the wrapper", () => {
    const findings = moduleReferenceFindings(
      [
        {
          file: "lib/ui/Cabinet.tsx",
          source:
            'import SharedSuppliesLink from "@/components/intake/SharedSuppliesLink"; export const Cabinet = SharedSuppliesLink',
        },
        {
          file: "app/a.tsx",
          source: 'import { Cabinet } from "@/lib/ui/Cabinet"; <Cabinet />',
        },
      ],
      "SharedSuppliesLink",
      "components/intake/SharedSuppliesLink.tsx",
      new Map()
    );
    expect(findings.join("\n")).toMatch(/lib\/ui\/Cabinet\.tsx/);
  });

  it("binds evidence inside the governed function, not global or destructured shadows", () => {
    expect(
      auditDestinationDoorSource(
        good.replace(
          "const identity = identityOf(destination);",
          "const { identity } = evidence;"
        ),
        contract
      ).issues
    ).toContain("binding:identity");
    expect(
      auditDestinationDoorSource(
        good.replace(
          "function Door() {\n      const identity = identityOf(destination);",
          "const identity = identityOf(destination);\n    function Door() {"
        ),
        contract
      ).issues
    ).toContain("binding:identity");
    expect(
      auditDestinationDoorSource(
        good.replace(
          "return <Link",
          "if (active) { const identity = other; }\n      return <Link"
        ),
        contract
      ).issues
    ).toContain("binding:identity");
    expect(
      auditDestinationDoorSource(
        good.replace("const identity", "let identity"),
        contract
      ).issues
    ).toContain("binding:identity");
    expect(
      auditDestinationDoorSource(
        good.replace("return <Link", "identity = other;\n      return <Link"),
        contract
      ).issues
    ).toContain("binding:identity");
    const shared = RENDERERS.find(
      (entry) => entry.contract.testId === "shared-supplies-link"
    )!;
    expect(
      auditDestinationDoorSource(
        read(shared.file).replace(
          "Medicine cabinet: ${label}",
          "Medicine  cabinet: ${label}"
        ),
        shared.contract
      ).issues
    ).toContain("binding:accessibleName");
  });

  it("makes a same-file chevron move change its structural identity", () => {
    const original =
      'import { IconChevronRight } from "@tabler/icons-react"; <div data-testid="row"><Link href="/row"><IconChevronRight aria-hidden /></Link></div>';
    const moved =
      'import { IconChevronRight } from "@tabler/icons-react"; <div data-testid="row"><Link href="/destination"><IconChevronRight aria-hidden /></Link></div>';
    expect(chevronSignature(moved)).not.toEqual(chevronSignature(original));
    expect(
      chevronOccurrences(original).flatMap((entry) => entry.issues)
    ).toEqual([]);
    expect(
      chevronOccurrences(
        original.replace("aria-hidden", "{...iconProps} aria-hidden")
      ).flatMap((entry) => entry.issues)
    ).toContain("chevron-spread-attributes");
    expect(
      chevronOccurrences(
        original.replace(
          '<Link href="/row"',
          '<Link {...ownerProps} href="/row"'
        )
      ).flatMap((entry) => entry.issues)
    ).toContain("chevron-owner-spread-attributes");
    expect(
      chevronOccurrences(
        original.replace(
          "import { IconChevronRight }",
          "const IconChevronRight = Local; import { Other }"
        )
      ).flatMap((entry) => entry.issues)
    ).toEqual(expect.arrayContaining(["chevron-import", "chevron-shadow"]));
    const profileSwitcher = read("components/ProfileSwitcherChip.tsx");
    expect(
      chevronSignature(
        profileSwitcher.replace("Open ${label} for", "Open  ${label} for")
      )
    ).not.toEqual(chevronSignature(profileSwitcher));
  });

  it("makes extra mounts and extra chevrons change exact occurrence maps", () => {
    const sources: Source[] = [
      { file: "a.tsx", source: "<Door /><IconChevronRight />" },
      { file: "b.tsx", source: "<Door />" },
    ];
    expect(
      plainMap(
        occurrenceMap(sources, (source) => jsxMountLines(source, "Door"))
      )
    ).toEqual({
      "a.tsx": 1,
      "b.tsx": 1,
    });
    expect(
      plainMap(
        occurrenceMap(
          [
            {
              file: "a.tsx",
              source: "<IconChevronRight /><IconChevronRight />",
            },
          ],
          chevronLines
        )
      )
    ).toEqual({ "a.tsx": 2 });
    expect(
      identifierLines(
        'import { IconChevronRight as Arrow } from "@tabler/icons-react"; <Arrow />',
        "IconChevronRight"
      )
    ).toHaveLength(1);
  });
});
