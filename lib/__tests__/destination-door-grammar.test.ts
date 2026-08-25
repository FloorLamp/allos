import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditDestinationDoorSource,
  chevronLines,
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
  return execFileSync("git", ["ls-files", "-z", "--", "app", "components"], {
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
  expectedFiles: ReadonlySet<string>
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
  for (const file of expectedFiles) {
    if (actualImportFiles.get(file) !== 1) {
      findings.push(
        `${file} has ${actualImportFiles.get(file) ?? 0} canonical imports of ${targetFile}; expected 1`
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
        moduleReferenceFindings(
          SOURCES,
          component,
          entry.targetFile,
          new Set(expected.keys())
        ),
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
  });
});

describe("the destination-door reader's reach", () => {
  const contract: DestinationDoorContract = {
    testId: "door",
    destinationExpression: "DESTINATION",
    label: { kind: "literal", value: "Destination" },
    childShape: ["text:Destination", "tag:IconChevronRight"],
    accessibleName: { kind: "visible-label" },
    treatment: { owner: "link", tokens: ["text-link", "gap-1"] },
    bindings: [{ name: "identity", expression: "identityOf(destination)" }],
  };
  const good = `
    import Link from "next/link";
    import { IconChevronRight } from "@tabler/icons-react";
    const identity = identityOf(destination);
    <Link href={DESTINATION} data-testid="door" className="text-link gap-1">
      Destination
      <IconChevronRight aria-hidden className="h-4 w-4" />
    </Link>
  `;

  it.each([
    ["destination", good.replace("href={DESTINATION}", "href={OTHER}")],
    ["label", good.replace("Destination\n", "Other\n")],
    ["label", good.replace("Destination\n", "Destination now\n")],
    ["label", good.replace("Destination\n", "<span>Destination</span>\n")],
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
    ["retired-arrow-glyph", good.replace("Destination\n", "Destination →\n")],
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
      new Set()
    );
    expect(findings).toHaveLength(5);
    expect(findings.join("\n")).toMatch(/import as Cabinet/);
    expect(findings.join("\n")).toMatch(/re-export/);
    expect(findings.join("\n")).toMatch(/dynamic-import/);
    expect(findings.join("\n")).toMatch(/require/);
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
