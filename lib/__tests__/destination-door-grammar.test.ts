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
  jsxMountOwnerLines,
  testIdLines,
  testIdOwnerLines,
  type DestinationDoorContract,
  type DoorOwner,
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
    return withoutSourceExtension(specifier.slice(2));
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
      testId: "shared-supplies-link",
      destinationExpression: "SUPPLIES_HREF",
      destinationBinding: "module",
      moduleBindings: [
        { name: "SUPPLIES_HREF", moduleName: "@/lib/hrefs" },
        { name: "sharedSuppliesLinkLabel", moduleName: "@/lib/refill" },
      ],
      title: "Medicine cabinet",
      label: { kind: "expression", value: "label" },
      childShape: ["tag:IconArchive", "expr:label", "tag:IconChevronRight"],
      accessibleName: { kind: "aria-label", value: "accessibleName" },
      treatment: { owner: "link", tokens: ["text-link", "gap-1"] },
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
      testId: "dose-ledger-link",
      destinationExpression: "doseLedgerHref(kind)",
      destinationBinding: "module",
      moduleBindings: [{ name: "doseLedgerHref", moduleName: "@/lib/hrefs" }],
      title: "Dose history",
      label: { kind: "literal", value: "Dose history" },
      childShape: [
        "tag:IconHistory",
        "text:Dose history",
        "tag:IconChevronRight",
      ],
      accessibleName: { kind: "visible-label" },
      treatment: { owner: "link", tokens: ["text-link", "gap-1"] },
    },
  },
  {
    file: "app/(app)/household/page.tsx",
    contract: {
      testId: "household-history-link",
      destinationExpression: "EPISODES_HREF",
      destinationBinding: "module",
      moduleBindings: [{ name: "EPISODES_HREF", moduleName: "@/lib/hrefs" }],
      label: { kind: "literal", value: "Illness episodes" },
      childShape: ["text:Illness episodes", "tag:IconChevronRight"],
      accessibleName: { kind: "visible-label" },
      treatment: { owner: "link", tokens: ["text-link", "gap-1"] },
    },
  },
  {
    file: "components/dashboard/DashboardStandingCluster.tsx",
    contract: {
      testId: "standing-door",
      destinationExpression: "presentation.href",
      moduleBindings: [
        { name: "trackedPageFor", moduleName: "@/lib/recent-pages" },
      ],
      label: { kind: "expression", value: "door" },
      childShape: ["expr:door", "tag:IconChevronRight"],
      accessibleName: { kind: "row-content", value: "content" },
      treatment: { owner: "door", tokens: ["standing-door", "gap-1"] },
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
};

const MOUNTS: ReadonlyArray<{
  component: string;
  targetFile: string;
  file: string;
  count: number;
  owner: string;
  ownerContract: DoorOwner;
}> = [
  {
    component: "SharedSuppliesLink",
    targetFile: "components/intake/SharedSuppliesLink.tsx",
    file: "app/(app)/household/page.tsx",
    count: 1,
    owner: "Household PageHeader.action — owner-approved paired doors (#3487)",
    ownerContract: HOUSEHOLD_HEADER_OWNER,
  },
  {
    component: "SharedSuppliesLink",
    targetFile: "components/intake/SharedSuppliesLink.tsx",
    file: "app/(app)/medications/MedicationBoard.tsx",
    count: 1,
    owner: "Current medications card (#3479)",
    ownerContract: {
      kind: "ancestor-attribute",
      ownerTag: "CardGroup",
      attribute: "title",
      value: "Current medications",
    },
  },
  {
    component: "SharedSuppliesLink",
    targetFile: "components/intake/SharedSuppliesLink.tsx",
    file: "app/(app)/nutrition/SupplementsTab.tsx",
    count: 2,
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
    ["Link[href:/data?section=import]||||true"],
  ],
  [
    "app/(app)/protocols/ProtocolList.tsx",
    ["Link|||`protocol-row-${p.id}`|true"],
  ],
  [
    "app/(app)/training/activity/[id]/ActivityDetailControls.tsx",
    ["span||Resume|session-in-progress|true"],
  ],
  [
    "app/(app)/training/activity/[id]/ActivityLedgerNav.tsx",
    ["PendingIconSlot|||activity-ledger-navigation|true"],
  ],
  [
    "components/activity-form/ActivityMoreDetails.tsx",
    ["button|||activity-more-details|true"],
  ],
  [
    "components/dashboard/IllnessNowGroup.tsx",
    ["span|||`illness-cockpit-toggle-${c.episodeKey}`|true"],
  ],
  [
    "components/integrations/SyncHistoryDays.tsx",
    ["summary|||sync-day-summary|true"],
  ],
  [
    "components/photo/PhotoGallery.tsx",
    ["button||Next photo|photo-lightbox-next|true"],
  ],
  [
    "components/AdherenceRefill.tsx",
    [
      'Link||`Sharedsupply—${bottleLabel(pool)},drawnfromby${pool.memberCount}trackeditem${pool.memberCount===1?"":"s"}`|shared-supply-chip|true',
    ],
  ],
  [
    "components/ClinicalResultsTable.tsx",
    ["button||panelGroupSummary(group)|clinical-result-panel-toggle|true"],
  ],
  ["components/DateField.tsx", ["button||Next month||true"]],
  ["components/EquipmentManager.tsx", ["Link|||equipment-row|true"]],
  ["components/HouseholdCard.tsx", ["button|||household-open|true"]],
  ["components/LeadFold.tsx", ["summary|||`${testId}-fold-summary`|true"]],
  [
    "components/Nav.tsx",
    ["button[aria-expanded:expanded,type:button]||||true"],
  ],
  ["components/ProducedListing.tsx", ["Link|||produced-item|true"]],
  ["components/ProducedProviders.tsx", ["Link|||produced-provider|true"]],
  [
    "components/ProfileSwitcherChip.tsx",
    [
      "binding:content→Link|button||`Open${label}for${profile.name}`|`Switchto${profile.name}andopen${label}`|testId|true",
    ],
  ],
  ["components/QuickLogSheet.tsx", ["button|||`quick-log-${item.id}`|true"]],
  [
    "components/RawDataViewer.tsx",
    ["component:Caret→button|||raw-node-toggle|true"],
  ],
  [
    "components/SessionComparisonChart.tsx",
    ["span|||`${testIdPrefix}-ranking`|true"],
  ],
  [
    "components/TimelineDayNav.tsx",
    ["PendingIconSlot|||timeline-day-nav|true"],
  ],
  ["components/TrainingLogCalendar.tsx", ["button||Next month||true"]],
]);

function chevronSignature(source: string): string[] {
  return chevronOccurrences(source).map(
    ({ ownerTag, role, label, testId, ariaHidden }) =>
      [ownerTag, role, label, testId, ariaHidden]
        .map((value) => value ?? "")
        .join("|")
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
    testId: "door",
    destinationExpression: "DESTINATION",
    destinationBinding: "module",
    label: { kind: "expression", value: "identity" },
    childShape: ["expr:identity", "tag:IconChevronRight"],
    accessibleName: { kind: "visible-label" },
    treatment: { owner: "link", tokens: ["text-link", "gap-1"] },
    bindings: [{ name: "identity", expression: "identityOf(destination)" }],
  };
  const good = `
    import Link from "next/link";
    import { IconChevronRight } from "@tabler/icons-react";
    function Door() {
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
  });

  it("pins Household's inline door inside PageHeader.action", () => {
    const housed = `
      <PageHeader action={<Link data-testid="household-history-link" />} />
    `;
    expect(
      testIdOwnerLines(housed, "household-history-link", HOUSEHOLD_HEADER_OWNER)
    ).toHaveLength(1);
    expect(
      testIdOwnerLines(
        '<PageHeader action={<Other />} /><Link data-testid="household-history-link" />',
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
    ]) {
      expect(
        testIdOwnerLines(
          rejected,
          "household-history-link",
          HOUSEHOLD_HEADER_OWNER
        )
      ).toEqual([]);
    }
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
  });

  it("binds the governed test id and label to the exact target node", () => {
    const nested = good.replace(
      'data-testid="door" className="text-link gap-1">',
      'className="text-link gap-1"><span data-testid="door">Wrong</span>'
    );
    const issues = auditDestinationDoorSource(nested, contract).issues;
    expect(issues).toContain("label");
    expect(issues).toContain("content-shape");
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
            "const A = import(`@/components/intake/SharedSuppliesLink`); const B = require(`@/components/intake/SharedSuppliesLink`)",
        },
      ],
      "SharedSuppliesLink",
      target,
      new Map()
    );
    expect(templateFindings.join("\n")).toMatch(/dynamic-import/);
    expect(templateFindings.join("\n")).toMatch(/require/);
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
  });

  it("makes a same-file chevron move change its structural identity", () => {
    const original =
      '<button data-testid="next"><IconChevronRight aria-hidden /></button>';
    const moved =
      '<button data-testid="next" /><Link><IconChevronRight aria-hidden /></Link>';
    expect(chevronSignature(moved)).not.toEqual(chevronSignature(original));
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
