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
  [
    "2237730c33aedf09362c718f",
    {},
    [
      "referenced-imports=a80b95769548914e8b7c31bb",
      "FunctionDeclaration:SharedSuppliesLink=ad6d72c9566191b77ba7b3fc",
      "FunctionDeclaration:SharedSuppliesLink>ExportKeyword=a5ebe53925e881f5c83fb53f",
      "FunctionDeclaration:SharedSuppliesLink>DefaultKeyword=82d4ba16d62f166ef3cb9fe0",
      "FunctionDeclaration:SharedSuppliesLink>Identifier=b5010d2741f1fceb0c30141c",
      "FunctionDeclaration:SharedSuppliesLink>Parameter=7e29fdd0e81f0e1debb30502",
      "FunctionDeclaration:SharedSuppliesLink>Block=71c8d35cdbc686f78b48387c",
    ],
  ],
  [
    "697d6b56b4b20b5f186eb8f3",
    {},
    [
      "referenced-imports=90349125e5bc1eb173ad3577",
      "FunctionDeclaration:DoseLedgerLink=35aa8820b1c106f80e595d2b",
      "FunctionDeclaration:DoseLedgerLink>ExportKeyword=a5ebe53925e881f5c83fb53f",
      "FunctionDeclaration:DoseLedgerLink>DefaultKeyword=82d4ba16d62f166ef3cb9fe0",
      "FunctionDeclaration:DoseLedgerLink>Identifier=7dbf91dd84b19533fe57f374",
      "FunctionDeclaration:DoseLedgerLink>Parameter=ebf7dfb75402f461f92cba51",
      "FunctionDeclaration:DoseLedgerLink>Block=ed3d7b17654c2eb4fc922b9e",
    ],
  ],
  [
    "31b532731d7a67cac6899d09",
    {},
    [
      "referenced-imports=45bd629a5089428fc8b7cbd0",
      "FunctionDeclaration:HouseholdPage=f4017d94e9e0885c58fc1cb2",
      "FunctionDeclaration:HouseholdPage>ExportKeyword=a5ebe53925e881f5c83fb53f",
      "FunctionDeclaration:HouseholdPage>DefaultKeyword=82d4ba16d62f166ef3cb9fe0",
      "FunctionDeclaration:HouseholdPage>AsyncKeyword=01406dca26728abf96db4fbc",
      "FunctionDeclaration:HouseholdPage>Identifier=4cddffb348134854734157e2",
      "FunctionDeclaration:HouseholdPage>Block=1a35d515f48e70b9925bd3c0",
    ],
  ],
  [
    "fe90dd6363fc168e264f7ceb",
    {
      doorLabel: "c6cf47ac0eb3fc32569abefb",
      SECTIONS: "c6253898e441a800a67bc7af",
    },
    [
      "referenced-imports=e49be473c6f324626ee87b03",
      "FunctionDeclaration:doorLabel=c6cf47ac0eb3fc32569abefb",
      "VariableStatement:SECTIONS=becb1b9943729d99c59f297e",
      "FunctionDeclaration:DashboardStandingCluster=0c9ff1deb0b557307b869cde",
      "FunctionDeclaration:DashboardStandingCluster>ExportKeyword=a5ebe53925e881f5c83fb53f",
      "FunctionDeclaration:DashboardStandingCluster>DefaultKeyword=82d4ba16d62f166ef3cb9fe0",
      "FunctionDeclaration:DashboardStandingCluster>Identifier=75d3f4be629d84fb48fb582b",
      "FunctionDeclaration:DashboardStandingCluster>Parameter=7e22548c7d3ba529b6eecb08",
      "FunctionDeclaration:DashboardStandingCluster>Block=e084e24978d9750af4aad401",
    ],
  ],
] as const;
const MEDICATION_BOARD_TRACE = [
  "referenced-imports=b70f7111a4661a380044edaa",
  "FunctionDeclaration:MedicationBoard=f49cec0f6d795c2876d42d38",
  "FunctionDeclaration:MedicationBoard>ExportKeyword=a5ebe53925e881f5c83fb53f",
  "FunctionDeclaration:MedicationBoard>DefaultKeyword=82d4ba16d62f166ef3cb9fe0",
  "FunctionDeclaration:MedicationBoard>Identifier=b256345b0121d93dd802b798",
  "FunctionDeclaration:MedicationBoard>Parameter=614104cc189bfbc6e38c27b4",
  "FunctionDeclaration:MedicationBoard>Block=1697aeaca16e84d9fc542733",
] as const;
const SUPPLEMENTS_TRACE = [
  "referenced-imports=29ca7d8364458a42c3d403be",
  "FunctionDeclaration:SupplementsTab=abe5b25451d6f80ae369ed5e",
  "FunctionDeclaration:SupplementsTab>ExportKeyword=a5ebe53925e881f5c83fb53f",
  "FunctionDeclaration:SupplementsTab>DefaultKeyword=82d4ba16d62f166ef3cb9fe0",
  "FunctionDeclaration:SupplementsTab>AsyncKeyword=01406dca26728abf96db4fbc",
  "FunctionDeclaration:SupplementsTab>Identifier=e97fe233b4a315aa7fa23cd3",
  "FunctionDeclaration:SupplementsTab>Parameter=96edf1b42a65e2cb55e6d0e3",
  "FunctionDeclaration:SupplementsTab>Block=45f190600d610850d026a2f0",
] as const;
const MEDICATIONS_TODAY_TRACE = [
  "referenced-imports=34b46ae914ed4ff6b2e13a6d",
  "FunctionDeclaration:MedicationsTodayPanel=849a095387f1352a01f45b22",
  "FunctionDeclaration:MedicationsTodayPanel>ExportKeyword=a5ebe53925e881f5c83fb53f",
  "FunctionDeclaration:MedicationsTodayPanel>DefaultKeyword=82d4ba16d62f166ef3cb9fe0",
  "FunctionDeclaration:MedicationsTodayPanel>Identifier=3bce0f42a89ea9e90f7da384",
  "FunctionDeclaration:MedicationsTodayPanel>Parameter=3520b35d0231630ed9bf23e8",
  "FunctionDeclaration:MedicationsTodayPanel>Block=e1d90bb72653b45e361bf618",
] as const;
const DASHBOARD_PLACEMENT_TRACE = [
  "referenced-imports=5b777e24729a23cc1c2bb3ac",
  "VariableStatement:EVERYTHING_LABELS=645ce7e6db42c4c3f69d3946",
  "FunctionDeclaration:groupsInPlacementOrder=0a85a110eb01f527bc020c64",
  "FunctionDeclaration:DashboardPlacementCanvas=f0fde1ab6c79af5b08c91b33",
  "FunctionDeclaration:DashboardPlacementCanvas>ExportKeyword=a5ebe53925e881f5c83fb53f",
  "FunctionDeclaration:DashboardPlacementCanvas>DefaultKeyword=82d4ba16d62f166ef3cb9fe0",
  "FunctionDeclaration:DashboardPlacementCanvas>Identifier=3047d4eed203d35e46d0f687",
  "FunctionDeclaration:DashboardPlacementCanvas>Parameter=9e71e0da182f6b3cdb81bdae",
  "FunctionDeclaration:DashboardPlacementCanvas>Block=18cfe4b57461cc2c35bae511",
] as const;
const MOUNT_DIGESTS = [
  [
    "44a11d29f49d32522e42f68a",
    "8a4e4745ab5f0d79b5f9336d",
    "2528c4f17826455acac5c546",
    "31b532731d7a67cac6899d09",
    RENDERER_DIGESTS[2][2],
  ],
  [
    "5d8bea847046b94fffb12c58",
    "eb74a4186fe285d653b0f656",
    "8ae920a3f246df93a79344dc",
    "5533cdc0ce922d7199c12787",
    MEDICATION_BOARD_TRACE,
  ],
  [
    "5d8bea847046b94fffb12c58",
    "984bba90b5d0c6035a1aa84b",
    "944890619abb2eba8842529c",
    "f24bb6371ca057dd4d791fbb",
    SUPPLEMENTS_TRACE,
  ],
  [
    "5d8bea847046b94fffb12c58",
    "c4149370e9e581eb9706a411",
    "c434e4878994c57e2420802c",
    "f24bb6371ca057dd4d791fbb",
    SUPPLEMENTS_TRACE,
  ],
  [
    "1237b129ddcac61ead20e8e1",
    "21831083a01f21cb87d1b616",
    "09fdde3a65c949ff9c86b864",
    "b81458b5bd6b2eaf454d009b",
    MEDICATIONS_TODAY_TRACE,
  ],
  [
    "ecee40029fa1a7b92a6ce48f",
    "984bba90b5d0c6035a1aa84b",
    "944890619abb2eba8842529c",
    "f24bb6371ca057dd4d791fbb",
    SUPPLEMENTS_TRACE,
  ],
  [
    "ecee40029fa1a7b92a6ce48f",
    "c4149370e9e581eb9706a411",
    "c434e4878994c57e2420802c",
    "f24bb6371ca057dd4d791fbb",
    SUPPLEMENTS_TRACE,
  ],
  [
    "0f3971f0ed1929325413bbaa",
    "b94c20b59e22d6a0d5663fdb",
    "4ec326c9a706d104fbe7d07f",
    "4555236216c95531d02e7f56",
    DASHBOARD_PLACEMENT_TRACE,
  ],
  [
    "a549d2af570db42bf8257ed7",
    "8a4e4745ab5f0d79b5f9336d",
    "2528c4f17826455acac5c546",
    "31b532731d7a67cac6899d09",
    RENDERER_DIGESTS[2][2],
  ],
] as const;
const NON_DOOR_DIGESTS: Readonly<Record<string, readonly string[]>> = {
  "app/(app)/immunizations/MyChartImport.tsx": [
    "icon:2e6cd3fde180803eb3cb9305|scope:MyChartImport:eb00df5f8870576e2d84d054",
  ],
  "app/(app)/protocols/ProtocolList.tsx": [
    "icon:cefbba138572800438dcc9fd|scope:<callback>:8c22d123558e5277901d0918",
  ],
  "app/(app)/training/activity/[id]/ActivityDetailControls.tsx": [
    "icon:751ccf4a1e72f66db3c144ac|scope:ActivityInProgressBanner:0ebdbffc8eb859db8a33f076",
  ],
  "app/(app)/training/activity/[id]/ActivityLedgerNav.tsx": [
    "icon:751ccf4a1e72f66db3c144ac|scope:<callback>:f278824ad4594783f4603726",
  ],
  "components/activity-form/ActivityMoreDetails.tsx": [
    "icon:a3f7a2dcb7834fb477f02dee|scope:ActivityMoreDetails:3f695c675b5d809b35094f00",
  ],
  "components/AdherenceRefill.tsx": [
    "icon:77f07e4bad01912e5f246777|scope:SharedSupplyChip:b6a595d57333a367f01e46c2",
  ],
  "components/ClinicalResultsTable.tsx": [
    "icon:78605ecb58e2844324723cbf|scope:PanelGroupHeader:d098b22c997ac406a0030aca",
  ],
  "components/dashboard/IllnessNowGroup.tsx": [
    "icon:7f133b86baf3b335d6271f2d|scope:<callback>:a50763595f70c5ea7d170326",
  ],
  "components/DateField.tsx": [
    "icon:f95d69d02012222928f231de|scope:<callback>:914e4c1d0b8db0a2497faea8",
  ],
  "components/EquipmentManager.tsx": [
    "icon:035b813c07391a370c7ad4d2|scope:<callback>:8fc24afca048bba97ab863e0",
  ],
  "components/HouseholdCard.tsx": [
    "icon:f66b9a0d9fdf9cad38d96c70|scope:HouseholdCard:0871b95d46e3585cba83eb97",
  ],
  "components/integrations/SyncHistoryDays.tsx": [
    "icon:6db96090846b1f9968efc216|scope:<callback>:d522d87181981177f642d7b3",
  ],
  "components/LeadFold.tsx": [
    "icon:be52c9e9d320379ee2cc5856|scope:LeadFold:f038b1217dd6c7c24908ea96",
  ],
  "components/Nav.tsx": [
    "icon:b4468f01d86c5355c011f5cd|scope:NavGroup:882c767257fcb9a7b6796f21",
  ],
  "components/photo/PhotoGallery.tsx": [
    "icon:b79396e08817d22690f6b64e|scope:PhotoGallery:26d02ebfc47a3432ee1aec50",
  ],
  "components/ProducedListing.tsx": [
    "icon:5339924eee9b0051018b112b|scope:<callback>:5d17675005c816c55877dc49",
  ],
  "components/ProducedProviders.tsx": [
    "icon:52d0a5adf4421ac4a1a98302|scope:<callback>:b5516c5ddc56ff53f3a09cde",
  ],
  "components/ProfileSwitcherChip.tsx": [
    "icon:5268bf7d97e991671f71a8fe|scope:ProfileSwitcherChip:10f1894abbbb676c6646a054",
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
  descriptorVersion: "door-ast-token-v2",
  typescriptVersion: "5.9.3",
  renderers: PLAN.renderers.map((entry, index) => ({
    ...entry,
    declarationDigest: RENDERER_DIGESTS[index][0],
    supportDigests: RENDERER_DIGESTS[index][1],
    declarationTrace: RENDERER_DIGESTS[index][2],
  })),
  mounts: PLAN.mounts.map((entry, index) => ({
    ...entry,
    nodeDigest: MOUNT_DIGESTS[index][0],
    ownerDigest: MOUNT_DIGESTS[index][1],
    pathDigest: MOUNT_DIGESTS[index][2],
    declarationDigest: MOUNT_DIGESTS[index][3],
    declarationTrace: MOUNT_DIGESTS[index][4],
  })),
  trustedSlots: [
    {
      ...PLAN.trustedSlots[0],
      declarationDigest: "e34124e832405663aa6fa807",
      declarationTrace: [
        "FunctionDeclaration:PageHeader=e3297cdcb039c61e632d5cac",
        "FunctionDeclaration:PageHeader>ExportKeyword=a5ebe53925e881f5c83fb53f",
        "FunctionDeclaration:PageHeader>Identifier=9bab6c60a286b2aa9d4f5ea8",
        "FunctionDeclaration:PageHeader>Parameter=5b9541df34779c025272238c",
        "FunctionDeclaration:PageHeader>Block=2a4418923b146280584e9613",
      ],
    },
    {
      ...PLAN.trustedSlots[1],
      declarationDigest: "797ca58de914760d6831b47b",
      declarationTrace: [
        "referenced-imports=63ecb0e754f97228b3b8dee6",
        "FunctionDeclaration:CardGroup=8704206000f4f5e560811833",
        "FunctionDeclaration:CardGroup>ExportKeyword=a5ebe53925e881f5c83fb53f",
        "FunctionDeclaration:CardGroup>DefaultKeyword=82d4ba16d62f166ef3cb9fe0",
        "FunctionDeclaration:CardGroup>Identifier=2757591de828114fa64f2421",
        "FunctionDeclaration:CardGroup>Parameter=fc72d25f378280b306e6c40c",
        "FunctionDeclaration:CardGroup>Block=fdd5fa8f4988e639690429e3",
      ],
    },
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
    'module["requ" + "ire"]("./door")',
    'globalThis[`require`]("./door")',
    'module[`requ${"ire"}`]("./door")',
    '(0, module["requ" + "ire"])("./door")',
    'module["requ" + "ire"].bind(null)("./door")',
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

  it("does not treat benign require names as runtime loaders", () => {
    expect(
      new DestinationDoorCorpus([
        {
          path: "lib/benign.ts",
          source: [
            "type Options = { require: boolean };",
            "const options: Options = { require: true };",
            "function label(require: string) { return require; }",
            "const value = options.require;",
          ].join("\n"),
        },
      ]).findings
    ).toEqual([]);
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
      source.replace("{ href }", "{ other: href }"),
      source
        .replace("<a href", "<div hidden><a href")
        .replace("</a>", "</a></div>"),
      source.replace("Open ${href}", "Open  ${href}"),
      source.replace(">Door</a>", "> Door </a>"),
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
          detail: expect.stringMatching(
            /span \d+-\d+; first structural difference \[\d+\]/
          ),
        }),
      ]);
    }
    const parameterFinding = auditDestinationDoorRegistry(
      new DestinationDoorCorpus([
        {
          path: "components/Door.tsx",
          source: source.replace("{ href }", "{ other: href }"),
        },
      ]),
      baseline
    );
    expect(parameterFinding[0]).toEqual(
      expect.objectContaining({
        detail: expect.stringContaining(">Parameter="),
      })
    );
  });

  it("pins recursively referenced module support and rejects top-level execution", () => {
    const source = [
      'import Link from "next/link";',
      'const DESTINATION = "/door";',
      "export default function Door() {",
      "return <Link href={DESTINATION}>Door</Link>;",
      "}",
    ].join("\n");
    const plan: DestinationDoorPlan = {
      renderers: [
        {
          key: "renderer:door",
          path: "components/Door.tsx",
          name: "Door",
          imports: [
            { moduleName: "next/link", imported: "default", local: "Link" },
          ],
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
      source.replace('"/door"', '"/other"'),
      source.replace('Link from "next/link"', 'Link from "next/navigation"'),
      `${source}\nDESTINATION = "/other";`,
    ]) {
      expect(
        auditDestinationDoorRegistry(
          new DestinationDoorCorpus([
            { path: "components/Door.tsx", source: mutation },
          ]),
          baseline
        ).length,
        mutation
      ).toBeGreaterThan(0);
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
        detail: expect.stringContaining("first structural difference"),
      }),
    ]);
    expect(
      auditDestinationDoorRegistry(
        new DestinationDoorCorpus([
          {
            path: "components/ui.tsx",
            source: source.replace("{ action }", "{ other: action }"),
          },
        ]),
        baseline
      )
    ).toEqual([expect.objectContaining({ key: "slot:header" })]);
  });

  it("rejects namespace governed imports and qualified chevrons", () => {
    const sources: DoorSource[] = [
      {
        path: "components/Door.tsx",
        source: "export default function Door() { return <div />; }",
      },
      {
        path: "app/page.tsx",
        source:
          'import Door from "@/components/Door"; export default function Page() { return <section data-testid="owner"><Door /></section>; }',
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
    const namespaceMount = sources[1].source
      .replace(
        'import Door from "@/components/Door";',
        'import Door from "@/components/Door"; import * as Doors from "@/components/Door";'
      )
      .replace("</section>", "<Doors.default /></section>");
    expect(
      auditDestinationDoorRegistry(
        new DestinationDoorCorpus([
          sources[0],
          { path: "app/page.tsx", source: namespaceMount },
        ]),
        baseline
      ).map((finding) => finding.key)
    ).toContain("component:Door");

    const iconCorpus = new DestinationDoorCorpus([
      {
        path: "components/IconRow.tsx",
        source:
          'import * as Icons from "@tabler/icons-react"; export function Row() { return <button><Icons.IconChevronRight /></button>; }',
      },
    ]);
    const empty = captureDestinationDoorRegistry(iconCorpus, {
      renderers: [],
      mounts: [],
      trustedSlots: [],
      nonDoorReasons: {},
    });
    expect(Object.keys(empty.nonDoorChevrons)).toEqual([
      "components/IconRow.tsx",
    ]);
    expect(auditDestinationDoorRegistry(iconCorpus, empty)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "non-door:reason-key-set" }),
        expect.objectContaining({ key: "non-door:icon-import" }),
      ])
    );
  });

  it("ignores all-type-only named re-export clauses", () => {
    const corpus = new DestinationDoorCorpus([
      {
        path: "lib/types.ts",
        source: 'export { type Missing } from "./missing";',
      },
    ]);
    const registry = captureDestinationDoorRegistry(corpus, {
      renderers: [],
      mounts: [],
      trustedSlots: [],
      nonDoorReasons: {},
    });
    expect(auditDestinationDoorRegistry(corpus, registry)).toEqual([]);
  });

  it("pins the TypeScript parser version exactly", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(REPO, "package.json"), "utf8")
    ) as { devDependencies: { typescript: string } };
    expect(manifest.devDependencies.typescript).toBe(
      REGISTRY.typescriptVersion
    );
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
