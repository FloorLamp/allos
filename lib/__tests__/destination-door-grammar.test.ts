import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditDestinationDoorSource,
  chevronLines,
  jsxMountLines,
  jsxMountOwnerLines,
  type DestinationDoorContract,
} from "../destination-door-grammar";

// THE DESTINATION-DOOR CENSUS (#3502).
//
// Four renderers produce nine current mounts. The exact mount registry is the
// owning-surface decision: a cabinet or ledger door moving back into a crowded
// page header is not made acceptable by keeping the same component and classes.
// Household is the deliberate opposite: #3487 owner-approved its two quiet
// cross-profile doors together in PageHeader.action, so this guard preserves the
// pair rather than applying #3479's Medications layout to a different surface.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function read(file: string): string {
  return fs.readFileSync(path.join(REPO, file), "utf8");
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
      label: { kind: "expression", value: "label" },
      accessibleName: { kind: "aria-label", value: "accessibleName" },
      treatment: { owner: "link", token: "text-link" },
      requiredSourceFragments: [
        "sharedSuppliesLinkLabel(count)",
        'title="Medicine cabinet"',
      ],
    },
  },
  {
    file: "components/intake/DoseLedgerLink.tsx",
    contract: {
      testId: "dose-ledger-link",
      destinationExpression: "doseLedgerHref(kind)",
      label: { kind: "literal", value: "Dose history" },
      accessibleName: { kind: "visible-label" },
      treatment: { owner: "link", token: "text-link" },
      requiredSourceFragments: ['title="Dose history"'],
    },
  },
  {
    file: "app/(app)/household/page.tsx",
    contract: {
      testId: "household-history-link",
      destinationExpression: "EPISODES_HREF",
      label: { kind: "literal", value: "Illness episodes" },
      accessibleName: { kind: "visible-label" },
      treatment: { owner: "link", token: "text-link" },
    },
  },
  {
    file: "components/dashboard/DashboardStandingCluster.tsx",
    contract: {
      testId: "standing-door",
      destinationExpression: "presentation.href",
      label: { kind: "expression", value: "door" },
      accessibleName: { kind: "row-content", value: "content" },
      treatment: { owner: "door", token: "standing-door" },
      requiredSourceFragments: ["trackedPageFor(href)?.label"],
    },
  },
];

const MOUNTS: ReadonlyArray<{
  component: string;
  file: string;
  count: number;
  owner: string;
  module: string;
  ownerTag: string;
  ownerEvidence: string;
}> = [
  {
    component: "SharedSuppliesLink",
    file: "app/(app)/household/page.tsx",
    count: 1,
    owner: "Household PageHeader.action — owner-approved paired doors (#3487)",
    module: "@/components/intake/SharedSuppliesLink",
    ownerTag: "PageHeader",
    ownerEvidence: "action=",
  },
  {
    component: "SharedSuppliesLink",
    file: "app/(app)/medications/MedicationBoard.tsx",
    count: 1,
    owner: "Current medications card (#3479)",
    module: "@/components/intake/SharedSuppliesLink",
    ownerTag: "CardGroup",
    ownerEvidence: 'title="Current medications"',
  },
  {
    component: "SharedSuppliesLink",
    file: "app/(app)/nutrition/SupplementsTab.tsx",
    count: 2,
    owner: "both Supplements layouts' Manage sections",
    module: "@/components/intake/SharedSuppliesLink",
    ownerTag: "section",
    ownerEvidence: "Manage",
  },
  {
    component: "DoseLedgerLink",
    file: "app/(app)/medications/MedicationsTodayPanel.tsx",
    count: 1,
    owner: "Medications Today card",
    module: "@/components/intake/DoseLedgerLink",
    ownerTag: "section",
    ownerEvidence: 'data-testid="medications-today"',
  },
  {
    component: "DoseLedgerLink",
    file: "app/(app)/nutrition/SupplementsTab.tsx",
    count: 2,
    owner: "both Supplements layouts' Manage sections",
    module: "@/components/intake/DoseLedgerLink",
    ownerTag: "section",
    ownerEvidence: "Manage",
  },
  {
    component: "DashboardStandingCluster",
    file: "components/dashboard/DashboardPlacementCanvas.tsx",
    count: 1,
    owner: "Dashboard Standing lane",
    module: "./DashboardStandingCluster",
    ownerTag: "div",
    ownerEvidence: "standing.length > 0",
  },
];

const GOVERNED_CHEVRON_FILES = new Set(RENDERERS.map((entry) => entry.file));

// IconChevronRight also serves these deliberately different idioms. Keeping the
// list explicit prevents a new chevron from being silently mistaken for a door
// (or a future door from escaping the door grammar as "just another arrow").
const NON_DOOR_CHEVRON_FILES = new Map<string, string>([
  [
    "app/(app)/immunizations/MyChartImport.tsx",
    "the trailing mark inside a whole-card Import navigation affordance",
  ],
  [
    "app/(app)/protocols/ProtocolList.tsx",
    "the trailing mark on each protocol record row",
  ],
  [
    "app/(app)/training/activity/[id]/ActivityDetailControls.tsx",
    "the Resume button's action cue",
  ],
  [
    "app/(app)/training/activity/[id]/ActivityLedgerNav.tsx",
    "next-record pagination",
  ],
  [
    "components/activity-form/ActivityMoreDetails.tsx",
    "a disclosure-state indicator",
  ],
  ["components/dashboard/IllnessNowGroup.tsx", "a disclosure-state indicator"],
  [
    "components/integrations/SyncHistoryDays.tsx",
    "a disclosure-state indicator",
  ],
  ["components/photo/PhotoGallery.tsx", "carousel next control"],
  [
    "components/AdherenceRefill.tsx",
    "the trailing mark on a refill detail row",
  ],
  ["components/ClinicalResultsTable.tsx", "a row disclosure-state indicator"],
  ["components/DateField.tsx", "calendar next-month control"],
  ["components/EquipmentManager.tsx", "the trailing mark on an equipment row"],
  ["components/HouseholdCard.tsx", "the trailing mark on a member card"],
  ["components/LeadFold.tsx", "the shared lead-fold disclosure indicator"],
  ["components/Nav.tsx", "navigation-group disclosure indicator"],
  [
    "components/ProducedListing.tsx",
    "the trailing mark on an imported record row",
  ],
  ["components/ProducedProviders.tsx", "the trailing mark on a provider row"],
  [
    "components/ProfileSwitcherChip.tsx",
    "the trailing mark on a profile switch row",
  ],
  [
    "components/QuickLogSheet.tsx",
    "the trailing mark on a quick-log action row",
  ],
  ["components/RawDataViewer.tsx", "raw-data tree disclosure indicator"],
  [
    "components/SessionComparisonChart.tsx",
    "the trailing mark on a comparison point",
  ],
  ["components/TimelineDayNav.tsx", "next-day pagination"],
  ["components/TrainingLogCalendar.tsx", "calendar next-month control"],
]);

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", "app", "components"], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter((file) => /\.(?:tsx|jsx)$/.test(file));
}

describe("destination-door grammar (#3502)", () => {
  it("keeps all four renderers on the destination/accessibility/chevron contract", () => {
    expect(RENDERERS).toHaveLength(4);
    const findings = RENDERERS.flatMap(({ file, contract }) =>
      auditDestinationDoorSource(read(file), contract).issues.map(
        (issue) => `${file}: ${issue}`
      )
    );
    expect(findings).toEqual([]);
  });

  it("finds exactly nine mounts on their owning surfaces", () => {
    const findings: string[] = [];
    let total = 1; // Household's inline Illness episodes renderer.
    for (const mount of MOUNTS) {
      const source = read(mount.file);
      const lines = jsxMountLines(source, mount.component);
      total += lines.length;
      if (lines.length !== mount.count) {
        findings.push(
          `${mount.file}: found ${lines.length} <${mount.component}> mounts; expected ` +
            `${mount.count} at ${mount.owner}`
        );
      }
      const owned = jsxMountOwnerLines(
        source,
        mount.component,
        mount.ownerTag,
        mount.ownerEvidence
      );
      if (owned.length !== mount.count) {
        findings.push(
          `${mount.file}: ${mount.count - owned.length} <${mount.component}> mount(s) ` +
            `escaped ${mount.owner}`
        );
      }
      const canonicalImport = new RegExp(
        `import\\s+${mount.component}(?:\\s*,\\s*\\{[\\s\\S]*?\\})?\\s+from\\s+["']${mount.module.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}["']`
      );
      if (!canonicalImport.test(source)) {
        findings.push(
          `${mount.file}: ${mount.component} does not use its canonical default import from ${mount.module}`
        );
      }
    }
    expect(findings).toEqual([]);
    expect(total).toBe(9);
  });

  it("classifies every IconChevronRight renderer as a door or an explicit non-door", () => {
    const actual = new Map<string, number>();
    for (const file of sourceFiles()) {
      const count = chevronLines(read(file)).length;
      if (count > 0) actual.set(file, count);
    }
    const registered = new Set([
      ...GOVERNED_CHEVRON_FILES,
      ...NON_DOOR_CHEVRON_FILES.keys(),
    ]);
    expect([...actual.keys()].sort()).toEqual([...registered].sort());
    for (const file of registered) {
      expect(
        actual.get(file),
        `${file} is registered but renders no chevron`
      ).toBeGreaterThan(0);
    }
  });
});

describe("the destination-door reader's reach", () => {
  const contract: DestinationDoorContract = {
    testId: "door",
    destinationExpression: "DESTINATION",
    label: { kind: "literal", value: "Destination" },
    accessibleName: { kind: "visible-label" },
    treatment: { owner: "link", token: "text-link" },
    requiredSourceFragments: ["identityOf(destination)"],
  };
  const good = `
    import Link from "next/link";
    import { IconChevronRight } from "@tabler/icons-react";
    const label = identityOf(destination);
    <Link href={DESTINATION} data-testid="door" className="text-sm text-link">
      Destination
      <IconChevronRight aria-hidden className="h-4 w-4" />
    </Link>
  `;

  it.each([
    ["destination", good.replace("href={DESTINATION}", "href={OTHER}")],
    ["label", good.replace("Destination\n      <", "Other\n      <")],
    ["treatment", good.replace("text-sm text-link", "text-sm")],
    ["chevron-count:0", good.replace(/<IconChevronRight[^>]+\/>/, "")],
    [
      "chevron-count:2",
      good.replace("</Link>", "<IconChevronRight aria-hidden />\n</Link>"),
    ],
    [
      "chevron-accessibility",
      good.replace("aria-hidden className", "className"),
    ],
    ["retired-arrow-glyph", good.replace("Destination\n", "Destination →\n")],
    [
      "identity:identityOf(destination)",
      good.replace("identityOf(destination)", "String(destination)"),
    ],
    ["link-import", good.replace("import Link", "import NextLink")],
    [
      "chevron-import",
      good.replace("{ IconChevronRight }", "{ IconChevronRight as Chevron }"),
    ],
    [
      "accessible-name",
      good.replace('data-testid="door"', 'data-testid="door" aria-hidden'),
    ],
  ])("sees %s", (issue, source) => {
    expect(auditDestinationDoorSource(source, contract).issues).toContain(
      issue
    );
  });

  it("stays quiet on a conforming door and does not classify a non-door arrow", () => {
    expect(auditDestinationDoorSource(good, contract).issues).toEqual([]);
    expect(
      auditDestinationDoorSource(
        `import Link from "next/link";
         import { IconChevronRight } from "@tabler/icons-react";
         <button><IconChevronRight aria-hidden /></button>`,
        contract
      ).issues
    ).toEqual(["target-count:0"]);
  });

  it("sees a mount moved outside its owning surface", () => {
    const housed = `
      <section data-owner="Manage"><Door /></section>
      <section data-owner="Other"><Other /></section>
    `;
    expect(jsxMountLines(housed, "Door")).toHaveLength(1);
    expect(
      jsxMountOwnerLines(housed, "Door", "section", 'data-owner="Manage"')
    ).toHaveLength(1);
    expect(
      jsxMountOwnerLines(
        housed.replace(
          '<section data-owner="Manage"><Door /></section>',
          '<section data-owner="Manage"><Other /></section><Door />'
        ),
        "Door",
        "section",
        'data-owner="Manage"'
      )
    ).toEqual([]);
  });
});
