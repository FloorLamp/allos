import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditDestinationDoorRegistry,
  captureDestinationDoorRegistry,
  DestinationDoorCorpus,
  type DestinationDoorPlan,
  type DestinationDoorRegistry,
  type DoorSource,
} from "../destination-door-grammar";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

function runtimeSources(): DoorSource[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((file) => /^(app|components|lib)\//.test(file))
    .filter((file) => EXTENSIONS.some((extension) => file.endsWith(extension)))
    .filter((file) => !/\/(?:__[^/]+__)\//.test(file))
    .filter((file) => !/\.(?:test|spec)\.[^.]+$/.test(file))
    .map((file) => ({
      path: file,
      source: fs.readFileSync(path.join(REPO, file), "utf8"),
    }));
}

const SOURCES = runtimeSources();
const CORPUS = new DestinationDoorCorpus(SOURCES);

const REASONS: Readonly<Record<string, string>> = {
  "app/(app)/immunizations/MyChartImport.tsx#1": "whole-card Import navigation",
  "app/(app)/protocols/ProtocolList.tsx#1": "protocol record navigation",
  "app/(app)/training/activity/[id]/ActivityDetailControls.tsx#1":
    "Resume action cue",
  "app/(app)/training/activity/[id]/ActivityLedgerNav.tsx#1":
    "next-record pagination",
  "components/activity-form/ActivityMoreDetails.tsx#1":
    "details disclosure state",
  "components/dashboard/IllnessNowGroup.tsx#1": "illness disclosure state",
  "components/integrations/SyncHistoryDays.tsx#1": "sync-day disclosure state",
  "components/photo/PhotoGallery.tsx#1": "carousel next",
  "components/AdherenceRefill.tsx#1": "refill detail navigation",
  "components/ClinicalResultsTable.tsx#1": "clinical row disclosure state",
  "components/DateField.tsx#1": "calendar next month",
  "components/EquipmentManager.tsx#1": "equipment record navigation",
  "components/HouseholdCard.tsx#1": "household member navigation",
  "components/LeadFold.tsx#1": "lead-fold disclosure",
  "components/Nav.tsx#1": "navigation-group disclosure",
  "components/ProducedListing.tsx#1": "imported record navigation",
  "components/ProducedProviders.tsx#1": "provider record navigation",
  "components/ProfileSwitcherChip.tsx#1": "profile switch navigation",
  "components/QuickLogSheet.tsx#1": "quick-log action row",
  "components/RawDataViewer.tsx#1": "raw tree disclosure",
  "components/SessionComparisonChart.tsx#1": "comparison point navigation",
  "components/TimelineDayNav.tsx#1": "next-day pagination",
  "components/TrainingLogCalendar.tsx#1": "calendar next month",
};

const PLAN: DestinationDoorPlan = {
  renderers: [
    {
      key: "renderer:shared-supplies",
      path: "components/intake/SharedSuppliesLink.tsx",
      name: "SharedSuppliesLink",
      chevronCount: 1,
      imports: [
        { moduleName: "next/link", imported: "default", local: "Link" },
        {
          moduleName: "@tabler/icons-react",
          imported: "IconChevronRight",
          local: "IconChevronRight",
        },
        {
          moduleName: "@/lib/hrefs",
          imported: "SUPPLIES_HREF",
          local: "SUPPLIES_HREF",
        },
        {
          moduleName: "@/lib/refill",
          imported: "sharedSuppliesLinkLabel",
          local: "sharedSuppliesLinkLabel",
        },
      ],
    },
    {
      key: "renderer:dose-ledger",
      path: "components/intake/DoseLedgerLink.tsx",
      name: "DoseLedgerLink",
      chevronCount: 1,
      imports: [
        { moduleName: "next/link", imported: "default", local: "Link" },
        {
          moduleName: "@tabler/icons-react",
          imported: "IconChevronRight",
          local: "IconChevronRight",
        },
        {
          moduleName: "@/lib/hrefs",
          imported: "doseLedgerHref",
          local: "doseLedgerHref",
        },
      ],
    },
    {
      key: "renderer:household",
      path: "app/(app)/household/page.tsx",
      name: "HouseholdPage",
      chevronCount: 1,
      imports: [
        { moduleName: "next/link", imported: "default", local: "Link" },
        {
          moduleName: "@tabler/icons-react",
          imported: "IconChevronRight",
          local: "IconChevronRight",
        },
        {
          moduleName: "@/lib/hrefs",
          imported: "EPISODES_HREF",
          local: "EPISODES_HREF",
        },
        {
          moduleName: "@/components/ui",
          imported: "PageHeader",
          local: "PageHeader",
        },
      ],
    },
    {
      key: "renderer:standing",
      path: "components/dashboard/DashboardStandingCluster.tsx",
      name: "DashboardStandingCluster",
      chevronCount: 1,
      supportNames: ["doorLabel", "SECTIONS"],
      imports: [
        { moduleName: "next/link", imported: "default", local: "Link" },
        {
          moduleName: "@tabler/icons-react",
          imported: "IconChevronRight",
          local: "IconChevronRight",
        },
        {
          moduleName: "@/lib/recent-pages",
          imported: "trackedPageFor",
          local: "trackedPageFor",
        },
      ],
    },
  ],
  mounts: [
    {
      key: "mount:shared:household",
      path: "app/(app)/household/page.tsx",
      identity: {
        kind: "component",
        name: "SharedSuppliesLink",
        modulePath: "components/intake/SharedSuppliesLink.tsx",
      },
      occurrence: 0,
      owner: { kind: "jsx-attribute", tag: "PageHeader", attribute: "action" },
      ownerImport: {
        moduleName: "@/components/ui",
        imported: "PageHeader",
        local: "PageHeader",
      },
    },
    {
      key: "mount:shared:medications",
      path: "app/(app)/medications/MedicationBoard.tsx",
      identity: {
        kind: "component",
        name: "SharedSuppliesLink",
        modulePath: "components/intake/SharedSuppliesLink.tsx",
      },
      occurrence: 0,
      owner: {
        kind: "ancestor-attribute",
        tag: "CardGroup",
        attribute: "title",
        value: "Current medications",
      },
      ownerImport: {
        moduleName: "@/components/CardGroup",
        imported: "default",
        local: "CardGroup",
      },
    },
    ...[0, 1].map(
      (occurrence) =>
        ({
          key: `mount:shared:supplements:${occurrence + 1}`,
          path: "app/(app)/nutrition/SupplementsTab.tsx",
          identity: {
            kind: "component",
            name: "SharedSuppliesLink",
            modulePath: "components/intake/SharedSuppliesLink.tsx",
          },
          occurrence,
          owner: {
            kind: "ancestor-heading",
            tag: "section",
            headingTag: "h2",
            text: "Manage",
          },
        }) as const
    ),
    {
      key: "mount:dose:medications",
      path: "app/(app)/medications/MedicationsTodayPanel.tsx",
      identity: {
        kind: "component",
        name: "DoseLedgerLink",
        modulePath: "components/intake/DoseLedgerLink.tsx",
      },
      occurrence: 0,
      owner: {
        kind: "ancestor-attribute",
        tag: "section",
        attribute: "data-testid",
        value: "medications-today",
      },
    },
    ...[0, 1].map(
      (occurrence) =>
        ({
          key: `mount:dose:supplements:${occurrence + 1}`,
          path: "app/(app)/nutrition/SupplementsTab.tsx",
          identity: {
            kind: "component",
            name: "DoseLedgerLink",
            modulePath: "components/intake/DoseLedgerLink.tsx",
          },
          occurrence,
          owner: {
            kind: "ancestor-heading",
            tag: "section",
            headingTag: "h2",
            text: "Manage",
          },
        }) as const
    ),
    {
      key: "mount:standing:dashboard",
      path: "components/dashboard/DashboardPlacementCanvas.tsx",
      identity: {
        kind: "component",
        name: "DashboardStandingCluster",
        modulePath: "components/dashboard/DashboardStandingCluster.tsx",
      },
      occurrence: 0,
      owner: { kind: "logical-and", expression: "standing.length > 0" },
    },
    {
      key: "mount:episodes:household",
      path: "app/(app)/household/page.tsx",
      identity: { kind: "test-id", value: "household-history-link" },
      occurrence: 0,
      owner: { kind: "jsx-attribute", tag: "PageHeader", attribute: "action" },
      ownerImport: {
        moduleName: "@/components/ui",
        imported: "PageHeader",
        local: "PageHeader",
      },
    },
  ],
  trustedSlots: [
    {
      key: "slot:page-header-action",
      path: "components/ui.tsx",
      name: "PageHeader",
      exportKind: "named",
    },
    {
      key: "slot:card-group-children",
      path: "components/CardGroup.tsx",
      name: "CardGroup",
      exportKind: "default",
    },
  ],
  nonDoorReasons: REASONS,
};

// Reviewed SHA-256 token digests (96-bit prefixes). Never replace these with a live
// capture: a governed source-shape change must fail until this registry is updated.
const RENDERER_DIGESTS = [
  ["71c8d35cdbc686f78b48387c", {}],
  ["2c7451695ecb701173844588", {}],
  ["68b3734c32537a95b4ff82d5", {}],
  [
    "45a94c7357d968120207127c",
    {
      doorLabel: "c6cf47ac0eb3fc32569abefb",
      SECTIONS: "c6253898e441a800a67bc7af",
    },
  ],
] as const;
const MOUNT_DIGESTS = [
  [
    "44a11d29f49d32522e42f68a",
    "14f4bb33540985aff0efba6d",
    "9c791121fe33dd467c480da4",
  ],
  [
    "5d8bea847046b94fffb12c58",
    "eb74a4186fe285d653b0f656",
    "8ae920a3f246df93a79344dc",
  ],
  [
    "5d8bea847046b94fffb12c58",
    "43af9b4205cade2b19698b2e",
    "944890619abb2eba8842529c",
  ],
  [
    "5d8bea847046b94fffb12c58",
    "049bd6bd49c4bed64a8da15b",
    "c434e4878994c57e2420802c",
  ],
  [
    "1237b129ddcac61ead20e8e1",
    "e12ce6ff9b25ff43f64a7ed7",
    "09fdde3a65c949ff9c86b864",
  ],
  [
    "ecee40029fa1a7b92a6ce48f",
    "43af9b4205cade2b19698b2e",
    "944890619abb2eba8842529c",
  ],
  [
    "ecee40029fa1a7b92a6ce48f",
    "049bd6bd49c4bed64a8da15b",
    "c434e4878994c57e2420802c",
  ],
  [
    "0f3971f0ed1929325413bbaa",
    "b94c20b59e22d6a0d5663fdb",
    "4ec326c9a706d104fbe7d07f",
  ],
  [
    "9fb7435d21ffcf353c385147",
    "14f4bb33540985aff0efba6d",
    "9c791121fe33dd467c480da4",
  ],
] as const;
const NON_DOOR_DIGESTS: Readonly<Record<string, readonly string[]>> = {
  "app/(app)/immunizations/MyChartImport.tsx": [
    "icon:2e6cd3fde180803eb3cb9305|scope:MyChartImport:e59e06a6fb170afdca165a43",
  ],
  "app/(app)/protocols/ProtocolList.tsx": [
    "icon:cefbba138572800438dcc9fd|scope:<callback>:a8a14ad5d09a143d00deff81",
  ],
  "app/(app)/training/activity/[id]/ActivityDetailControls.tsx": [
    "icon:751ccf4a1e72f66db3c144ac|scope:ActivityInProgressBanner:655f2b8d2659f0ae84951e96",
  ],
  "app/(app)/training/activity/[id]/ActivityLedgerNav.tsx": [
    "icon:751ccf4a1e72f66db3c144ac|scope:<callback>:d2a904820c82ff2407f35946",
  ],
  "components/activity-form/ActivityMoreDetails.tsx": [
    "icon:a3f7a2dcb7834fb477f02dee|scope:ActivityMoreDetails:fb4e638ee67bf251b044dad3",
  ],
  "components/AdherenceRefill.tsx": [
    "icon:77f07e4bad01912e5f246777|scope:SharedSupplyChip:d164e03588e38c8389b4bf8e",
  ],
  "components/ClinicalResultsTable.tsx": [
    "icon:78605ecb58e2844324723cbf|scope:PanelGroupHeader:753a925d1400651c6a8a557c",
  ],
  "components/dashboard/IllnessNowGroup.tsx": [
    "icon:7f133b86baf3b335d6271f2d|scope:<callback>:86fe7ba06d0933572f381230",
  ],
  "components/DateField.tsx": [
    "icon:f95d69d02012222928f231de|scope:<callback>:0982bd65ea5fe60399fe5062",
  ],
  "components/EquipmentManager.tsx": [
    "icon:035b813c07391a370c7ad4d2|scope:<callback>:3869787276c586b1f3776be8",
  ],
  "components/HouseholdCard.tsx": [
    "icon:f66b9a0d9fdf9cad38d96c70|scope:HouseholdCard:8b70194c9097e3cb54fab83c",
  ],
  "components/integrations/SyncHistoryDays.tsx": [
    "icon:6db96090846b1f9968efc216|scope:<callback>:9765e8fd4de9ecae20ba0dd9",
  ],
  "components/LeadFold.tsx": [
    "icon:be52c9e9d320379ee2cc5856|scope:LeadFold:f038b1217dd6c7c24908ea96",
  ],
  "components/Nav.tsx": [
    "icon:b4468f01d86c5355c011f5cd|scope:NavGroup:882c767257fcb9a7b6796f21",
  ],
  "components/photo/PhotoGallery.tsx": [
    "icon:b79396e08817d22690f6b64e|scope:PhotoGallery:12910ae578a9a911282dec6f",
  ],
  "components/ProducedListing.tsx": [
    "icon:5339924eee9b0051018b112b|scope:<callback>:5d17675005c816c55877dc49",
  ],
  "components/ProducedProviders.tsx": [
    "icon:52d0a5adf4421ac4a1a98302|scope:<callback>:b5516c5ddc56ff53f3a09cde",
  ],
  "components/ProfileSwitcherChip.tsx": [
    "icon:5268bf7d97e991671f71a8fe|scope:ProfileSwitcherChip:c2a699f4999d9b43186a7b3c",
  ],
  "components/QuickLogSheet.tsx": [
    "icon:03b7b8ece5ed1ef754f22bb8|scope:<callback>:bf9d48ac0ef6314feef304c4",
  ],
  "components/RawDataViewer.tsx": [
    "icon:c80c37f436d31b2365d8c7e7|scope:Caret:bdf0539971ad53051d01ea66",
  ],
  "components/SessionComparisonChart.tsx": [
    "icon:5cae90e2cbaa1f42d37241f2|scope:<callback>:a819c722e1d5fa38bc4ac07c",
  ],
  "components/TimelineDayNav.tsx": [
    "icon:6c93a94a5cfe6db601e33238|scope:<callback>:cb8c1955dfc604da67ab5980",
  ],
  "components/TrainingLogCalendar.tsx": [
    "icon:f95d69d02012222928f231de|scope:TrainingLogCalendar:9d9794f65421ade98c070543",
  ],
};
const REGISTRY: DestinationDoorRegistry = {
  descriptorVersion: "door-ast-token-v1",
  typescriptVersion: "5.9.3",
  renderers: PLAN.renderers.map((entry, index) => ({
    ...entry,
    bodyDigest: RENDERER_DIGESTS[index][0],
    supportDigests: RENDERER_DIGESTS[index][1],
  })),
  mounts: PLAN.mounts.map((entry, index) => ({
    ...entry,
    nodeDigest: MOUNT_DIGESTS[index][0],
    ownerDigest: MOUNT_DIGESTS[index][1],
    pathDigest: MOUNT_DIGESTS[index][2],
  })),
  trustedSlots: [
    { ...PLAN.trustedSlots[0], bodyDigest: "2a4418923b146280584e9613" },
    { ...PLAN.trustedSlots[1], bodyDigest: "fdd5fa8f4988e639690429e3" },
  ],
  nonDoorChevrons: NON_DOOR_DIGESTS,
  nonDoorReasons: REASONS,
};

function smallRegistry(
  sources: readonly DoorSource[],
  plan: DestinationDoorPlan
): {
  corpus: DestinationDoorCorpus;
  registry: DestinationDoorRegistry;
} {
  const corpus = new DestinationDoorCorpus(sources);
  return { corpus, registry: captureDestinationDoorRegistry(corpus, plan) };
}

describe("destination-door source-shape registry (#3502)", () => {
  it("keeps the tracked runtime corpus parseable and the exact registry current", () => {
    expect(SOURCES.length).toBeGreaterThan(1_000);
    expect(CORPUS.findings).toEqual([]);
    expect(PLAN.renderers).toHaveLength(4);
    expect(PLAN.mounts).toHaveLength(9);
    expect(Object.keys(REASONS)).toHaveLength(23);
    expect(auditDestinationDoorRegistry(CORPUS, REGISTRY)).toEqual([]);
  });

  it("uses the real extension syntax mode and reports parse diagnostics", () => {
    expect(
      new DestinationDoorCorpus([
        { path: "components/good.tsx", source: "export const x = <div />;" },
      ]).findings
    ).toEqual([]);
    const bad = new DestinationDoorCorpus([
      { path: "lib/bad.ts", source: "export const x = <div />;" },
    ]);
    expect(bad.findings).toEqual([
      expect.objectContaining({ key: "parse", path: "lib/bad.ts", line: 1 }),
    ]);
  });

  it.each([
    "import(target)",
    "import(target, options)",
    'const load = require; load("./door")',
    'module.require("./door")',
    'require.call(null, "./door")',
    'require.bind(null)("./door")',
    'require.apply(null, ["./door"])',
    'require("./door")',
    'import Door = require("./door")',
    "const load = createRequire(import.meta.url)",
  ])("fails loud on unsupported runtime loader: %s", (source) => {
    expect(
      new DestinationDoorCorpus([{ path: "lib/loader.ts", source }]).findings
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "runtime-loader",
          path: "lib/loader.ts",
        }),
      ])
    );
  });

  it("allows the repository's legitimate literal import() shape", () => {
    expect(
      new DestinationDoorCorpus([
        {
          path: "components/Lazy.tsx",
          source: 'const View = dynamic(() => import("./View"));',
        },
      ]).findings
    ).toEqual([]);
  });

  it("makes renderer control flow, mutation, hiding, and literal whitespace review events", () => {
    const source = [
      "export default function Door({ href }: { href: string }) {",
      "return <a href={href} aria-label={`Open ${href}`}>Door</a>;",
      "}",
    ].join("\n");
    const plan: DestinationDoorPlan = {
      renderers: [
        {
          key: "renderer:door",
          path: "components/Door.tsx",
          name: "Door",
          imports: [],
          chevronCount: 0,
        },
      ],
      mounts: [],
      trustedSlots: [],
      nonDoorReasons: {},
    };
    const baseline = smallRegistry(
      [{ path: "components/Door.tsx", source }],
      plan
    ).registry;
    for (const mutation of [
      source.replace("return <a", "if (href) return null; return <a"),
      source.replace("return <a", "href = other; return <a"),
      source
        .replace("<a href", "<div hidden><a href")
        .replace("</a>", "</a></div>"),
      source.replace("Open ${href}", "Open  ${href}"),
      source
        .replace("return <a", "return items.map(() => <a")
        .replace("</a>;", "</a>);"),
    ]) {
      const findings = auditDestinationDoorRegistry(
        new DestinationDoorCorpus([
          { path: "components/Door.tsx", source: mutation },
        ]),
        baseline
      );
      expect(findings, mutation).toEqual([
        expect.objectContaining({
          key: "renderer:door",
          detail: expect.stringContaining("renderer-body digest changed"),
        }),
      ]);
    }
  });

  it("pins each mount node, semantic owner, path, and canonical binding", () => {
    const sources: DoorSource[] = [
      {
        path: "components/Door.tsx",
        source: "export default function Door() { return <div />; }",
      },
      {
        path: "app/page.tsx",
        source:
          'import Door from "@/components/Door"; export default function Page() { return <section data-testid="owner"><Door kind="x" /></section>; }',
      },
    ];
    const plan: DestinationDoorPlan = {
      renderers: [],
      mounts: [
        {
          key: "mount:door",
          path: "app/page.tsx",
          identity: {
            kind: "component",
            name: "Door",
            modulePath: "components/Door.tsx",
          },
          occurrence: 0,
          owner: {
            kind: "ancestor-attribute",
            tag: "section",
            attribute: "data-testid",
            value: "owner",
          },
        },
      ],
      trustedSlots: [],
      nonDoorReasons: {},
    };
    const baseline = smallRegistry(sources, plan).registry;
    for (const mutation of [
      sources[1].source.replace('kind="x"', 'kind="y"'),
      sources[1].source
        .replace("<Door", "<div hidden><Door")
        .replace("</section>", "</div></section>"),
      sources[1].source.replace(
        '<section data-testid="owner">',
        'false && <section data-testid="owner">'
      ),
      sources[1].source.replace(
        'import Door from "@/components/Door";',
        'import RealDoor from "@/components/Door"; const Door = Fake;'
      ),
    ]) {
      expect(
        auditDestinationDoorRegistry(
          new DestinationDoorCorpus([
            sources[0],
            { path: "app/page.tsx", source: mutation },
          ]),
          baseline
        ).length,
        mutation
      ).toBeGreaterThan(0);
    }
  });

  it("pins trusted slot forwarding bodies", () => {
    const source =
      "export function PageHeader({ action }: { action: unknown }) { return <header>{action}</header>; }";
    const plan: DestinationDoorPlan = {
      renderers: [],
      mounts: [],
      trustedSlots: [
        {
          key: "slot:header",
          path: "components/ui.tsx",
          name: "PageHeader",
          exportKind: "named",
        },
      ],
      nonDoorReasons: {},
    };
    const baseline = smallRegistry(
      [{ path: "components/ui.tsx", source }],
      plan
    ).registry;
    expect(
      auditDestinationDoorRegistry(
        new DestinationDoorCorpus([
          {
            path: "components/ui.tsx",
            source: source.replace("{action}", "{null}"),
          },
        ]),
        baseline
      )
    ).toEqual([
      expect.objectContaining({
        key: "slot:header",
        detail: expect.stringContaining("trusted-slot-body digest changed"),
      }),
    ]);
  });

  it("uses an exact non-door file+ordinal key set and token signature", () => {
    const source =
      'import { IconChevronRight } from "@tabler/icons-react"; export function Row() { return <button aria-label={`Open row`}><IconChevronRight aria-hidden /></button>; }';
    const plan: DestinationDoorPlan = {
      renderers: [],
      mounts: [],
      trustedSlots: [],
      nonDoorReasons: { "components/Row.tsx#1": "record navigation" },
    };
    const baseline = smallRegistry(
      [{ path: "components/Row.tsx", source }],
      plan
    ).registry;
    for (const mutation of [
      source.replace("Open row", "Open  row"),
      source.replace("aria-hidden", 'aria-hidden="false"'),
      source
        .replace("<button", '<a href="/destination"')
        .replace("</button>", "</a>"),
    ]) {
      expect(
        auditDestinationDoorRegistry(
          new DestinationDoorCorpus([
            { path: "components/Row.tsx", source: mutation },
          ]),
          baseline
        )
      ).toEqual([expect.objectContaining({ key: "non-door:signature" })]);
    }
    expect(
      auditDestinationDoorRegistry(
        new DestinationDoorCorpus([
          { path: "components/Row.tsx", source },
          {
            path: "components/Extra.tsx",
            source:
              'import { IconChevronRight } from "@tabler/icons-react"; <button><IconChevronRight aria-hidden /></button>',
          },
        ]),
        baseline
      ).map((entry) => entry.key)
    ).toEqual(
      expect.arrayContaining(["non-door:key-set", "non-door:reason-key-set"])
    );
  });
});
