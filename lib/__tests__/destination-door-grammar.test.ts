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
function reviewedTrace(parts: TemplateStringsArray): readonly string[] {
  return parts[0].trim().split("\n");
}

const RENDERER_1_SHAPE = {
  digest: "c7ec89b99adda0c91ef9e19b",
  trace: reviewedTrace`
import:"next/link"#1=da9ec5d2cfb1e184473dcc0a
import:"@tabler/icons-react"#1=ba900220220ace8a0aec530f
import:"@/lib/refill"#1=1eca53eff91aa993ab3c9c67
import:"@/lib/hrefs"#1=06b261862a6836a2a1c6a853
FunctionDeclaration:SharedSuppliesLink#1=ad6d72c9566191b77ba7b3fc
FunctionDeclaration:SharedSuppliesLink#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:SharedSuppliesLink#1>DefaultKeyword=82d4ba16d62f166ef3cb9fe0
FunctionDeclaration:SharedSuppliesLink#1>Identifier=b5010d2741f1fceb0c30141c
FunctionDeclaration:SharedSuppliesLink#1>Parameter=7e29fdd0e81f0e1debb30502
FunctionDeclaration:SharedSuppliesLink#1>Block=71c8d35cdbc686f78b48387c
`,
} as const;
const RENDERER_2_SHAPE = {
  digest: "01954708314d63f9e0556ddc",
  trace: reviewedTrace`
import:"next/link"#1=da9ec5d2cfb1e184473dcc0a
import:"@tabler/icons-react"#1=6bcd1e6b9a1560a99e7e888d
import:"@/lib/hrefs"#1=431621129dcce3fe9404dd49
FunctionDeclaration:DoseLedgerLink#1=35aa8820b1c106f80e595d2b
FunctionDeclaration:DoseLedgerLink#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:DoseLedgerLink#1>DefaultKeyword=82d4ba16d62f166ef3cb9fe0
FunctionDeclaration:DoseLedgerLink#1>Identifier=7dbf91dd84b19533fe57f374
FunctionDeclaration:DoseLedgerLink#1>Parameter=ebf7dfb75402f461f92cba51
FunctionDeclaration:DoseLedgerLink#1>Block=ed3d7b17654c2eb4fc922b9e
`,
} as const;
const RENDERER_3_SHAPE = {
  digest: "2be2cd6bbde5dae60230dc4f",
  trace: reviewedTrace`
import:"next/navigation"#1=f0401e5dd2f68adf37abbede
import:"next/link"#1=da9ec5d2cfb1e184473dcc0a
import:"@tabler/icons-react"#1=fe51acb8ea4ca0a51b49fdbe
import:"@/lib/auth"#1=c6c60904dc21b075d4254185
import:"@/lib/profile-disambiguation"#1=73c641d79679b74b8fe4ebb2
import:"@/lib/own-profile"#1=14c9ed7933412e0624e197a1
import:"@/lib/hrefs"#1=3cf1b07d5ca4074095990ee6
import:"@/lib/db"#1=5592e4cbd9d2959eda469c53
import:"@/lib/queries"#1=96b4f834bc808af6abd802a3
import:"@/lib/queries/household-setup"#1=c714dd3598810ea399b54ce6
import:"@/lib/rule-findings"#1=c5e67757da683e2760d06d33
import:"@/lib/data-quality"#1=5b99a35c63c372c0f19151cc
import:"@/lib/findings"#1=7c039c74ef819c05f22138af
import:"@/lib/settings"#1=a15fd978d419fd2918fc38f3
import:"@/lib/life-stage"#1=70de0afe66a15748f4618f7a
import:"@/lib/longevity-pillars"#1=6576847be632e8b92818bce0
import:"@/lib/illness-episode"#1=522e9ad5e22ec9f63ce31d0c
import:"@/lib/illness-episode-format"#1=be8e86ed358c048375c6b702
import:"@/lib/school-return-data"#1=eb0dc89b024092dc866e00d3
import:"@/lib/school-return"#1=7c931e98ae644c2931749d84
import:"@/lib/household"#1=b0fb2ad1cce9a935bd5936fd
import:"@/lib/units"#1=34441ef7c0e5f8e7271783de
import:"@/lib/workout-presence"#1=04028653272229a6d74b7110
import:"@/lib/format-date"#1=2abd5658625428b108168503
import:"@/lib/date"#1=1456170e28d256d01576bed9
import:"@/components/ui"#1=593566359a4f342582b6c47f
import:"@/components/intake/SharedSuppliesLink"#1=8433a646c7bb25970b7afbbb
import:"@/lib/intake-history"#1=ee152fb76170ce6a0032b4fd
import:"@/components/HouseholdCard"#1=c4f56eea690fdd677e9bddf9
VariableStatement:dynamic#1=2c333a385bf565c19065a40b
FunctionDeclaration:HouseholdPage#1=f4017d94e9e0885c58fc1cb2
FunctionDeclaration:HouseholdPage#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:HouseholdPage#1>DefaultKeyword=82d4ba16d62f166ef3cb9fe0
FunctionDeclaration:HouseholdPage#1>AsyncKeyword=01406dca26728abf96db4fbc
FunctionDeclaration:HouseholdPage#1>Identifier=4cddffb348134854734157e2
FunctionDeclaration:HouseholdPage#1>Block=1a35d515f48e70b9925bd3c0
`,
} as const;
const RENDERER_4_SHAPE = {
  digest: "6aaad7ef6b510b549e2b8916",
  trace: reviewedTrace`
import:"next/link"#1=da9ec5d2cfb1e184473dcc0a
import:"@tabler/icons-react"#1=fe51acb8ea4ca0a51b49fdbe
import:"@/lib/recent-pages"#1=390b7f0f34976a92498661fd
import:"./StandingSparkline"#1=e3247b9af0a00903d6979ae9
import:"@/lib/dashboard-standing"#1=0601310667d3f731000f36d0
FunctionDeclaration:doorLabel#1=c6cf47ac0eb3fc32569abefb
VariableStatement:SECTIONS#1=becb1b9943729d99c59f297e
FunctionDeclaration:DashboardStandingCluster#1=0c9ff1deb0b557307b869cde
FunctionDeclaration:DashboardStandingCluster#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:DashboardStandingCluster#1>DefaultKeyword=82d4ba16d62f166ef3cb9fe0
FunctionDeclaration:DashboardStandingCluster#1>Identifier=75d3f4be629d84fb48fb582b
FunctionDeclaration:DashboardStandingCluster#1>Parameter=7e22548c7d3ba529b6eecb08
FunctionDeclaration:DashboardStandingCluster#1>Block=e084e24978d9750af4aad401
`,
} as const;
const RENDERER_SHAPES = [
  RENDERER_1_SHAPE,
  RENDERER_2_SHAPE,
  RENDERER_3_SHAPE,
  RENDERER_4_SHAPE,
] as const;
const MEDICATION_BOARD_SHAPE = {
  digest: "8b01cc85a4db092c2668711f",
  trace: reviewedTrace`
import:"next/link"#1=da9ec5d2cfb1e184473dcc0a
import:"@tabler/icons-react"#1=fc01b3bbb6dd9a85f3147f03
import:"@/components/Avatar"#1=7de3f3e240eb00de8f69cbf6
import:"@/components/IntakeWarnings"#1=93e1f19676833b0977d2bd87
import:"@/components/CardGroup"#1=871587e7fa23345788507b40
import:"@/components/intake/SharedSuppliesLink"#1=8433a646c7bb25970b7afbbb
import:"@/lib/hrefs"#1=0e8451a8cf670f7cf7a68d88
import:"@/lib/medication-multi-view"#1=2ee296294ed47ad7b6b5dbea
import:"./MedicationsTodayPanel"#1=de283e78779212cbf069c4f2
import:"./MedicationRow"#1=ea25c12b0d28058cfa6e7171
import:"./MedicationListActions"#1=3ee95b1d2df39baaf932152f
import:"./DormantPrnSweep"#1=73399f046ade62b238a4cb96
FunctionDeclaration:MedicationBoard#1=f49cec0f6d795c2876d42d38
FunctionDeclaration:MedicationBoard#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:MedicationBoard#1>DefaultKeyword=82d4ba16d62f166ef3cb9fe0
FunctionDeclaration:MedicationBoard#1>Identifier=b256345b0121d93dd802b798
FunctionDeclaration:MedicationBoard#1>Parameter=614104cc189bfbc6e38c27b4
FunctionDeclaration:MedicationBoard#1>Block=1697aeaca16e84d9fc542733
`,
} as const;
const SUPPLEMENTS_SHAPE = {
  digest: "90071e252c00949216e4d47d",
  trace: reviewedTrace`
import:"@/lib/queries"#1=1b2316440fff0a0b729682bc
import:"@/lib/findings"#1=427568a054024927fa7e91d1
import:"@/lib/rule-findings"#1=b69ac2e7ec71a1175e410072
import:"@/lib/intake-warning-surface"#1=30c2828862b2d06335f2efed
import:"@/lib/upcoming-suppress"#1=f02956e7a3fc5556cfe651cc
import:"@/lib/dri"#1=089c7489cfca4ad34cb3e51a
import:"@/lib/food-suggest"#1=4db0adaf161c572e2dbfb018
import:"@/lib/food-drug-interactions"#1=7a44481f12e952a2195a9e65
import:"@/components/FindingCard"#1=8157eb6c2402a98f76424d85
import:"@/components/Notice"#1=512b466ba9b9d9311f9f33c0
import:"@/components/IntakeWarnings"#1=93e1f19676833b0977d2bd87
import:"@/lib/db"#1=5592e4cbd9d2959eda469c53
import:"@/lib/rxnorm"#1=f6f7b027d9b3beea19f36a1d
import:"@/lib/auth"#1=c6d36f77f5c28fb2d5473f8f
import:"@/lib/scope"#1=840630e79145e5f7c2475c25
import:"@/components/intake/SharedSuppliesLink"#1=8433a646c7bb25970b7afbbb
import:"@/components/intake/DoseLedgerLink"#1=8d5248d0800bf4f438a6f391
import:"@/lib/date"#1=df25ec830266d7e3c851fbe7
import:"@/lib/row-instants"#1=2324159828abb6f9fd7e7176
import:"@/lib/administration-format"#1=a12cb2f47cc41717aeda67d8
import:"@/lib/settings"#1=f5f4d550c36f387ccc90feae
import:"@/lib/life-stage"#1=1def32afba923e0fb0acdd00
import:"@/lib/format-date"#1=b1978e67450ab818172dd99f
import:"@/lib/week-window"#1=a7d478e59fe7140b9fd688ca
import:"@/lib/travel-excusal"#1=496a7b0baf136458042a95a2
import:"@/lib/trend-annotations"#1=1630e05201bc624260b74113
import:"@/lib/situations"#1=47746ae16e2c5114ffff4e5e
import:"@/lib/derived-situations"#1=f6333754406be7d1eff280f6
import:"@/lib/queries/weather-situations"#1=9e3febf1f135e08e07b16dc3
import:"@/lib/settings"#2=dbaeef928e016fcde7320344
import:"@/lib/intake-schedule"#1=8f96080a4bf8ba75e5accaf0
import:"@/lib/dose-order"#1=63f80a37945cd079488ec54c
import:"@/components/ui"#1=0f98854ac9897c0158ba0f09
import:"@/components/SubmitButton"#1=c424a897e627ebf860c8ffbc
import:"@/components/SituationOptionsContext"#1=4542249d2b6fadd72780417a
import:"@/components/IntakeOptionsContext"#1=4ce7b50f10386a69b923a508
import:"./EditableSupplementRow"#1=5be4b9859670dc1a89dc359c
import:"./DismissSuggestionButton"#1=3aa5f5207cab9dcf122d01ab
import:"@/lib/intake-adherence"#1=66e622ea4b02ede2b23cf3e7
import:"@/lib/intake-pairs"#1=a963af3f749df11aa8de07bb
import:"./SuggestionsForm"#1=3c1df6320caeb5732c6224f2
import:"@/components/CuratedSupplementSuggestions"#1=b3a7e3deed5e8db9cff2a16f
import:"@/components/InfoTooltipIcon"#1=1ea4b1b2e45e19d54eafa401
import:"./AdherenceFindings"#1=81b39daf6a3f6a5fb5e66bcc
import:"./DemotionSuggestions"#1=ea44fc12f5215208f820d975
import:"./SupplementSchedule"#1=eedea97ff79d61d31ad6bc2c
import:"./SupplementInsightBadges"#1=5de1b5f4406071fff490313f
import:"./AddSupplementModal"#1=e5932f49d285143a1bf97b1d
import:"@/components/SupplementWeeklyAdherence"#1=25ce842e90807737bba3a36d
import:"./intake-actions"#1=6e5bfa9f4b671b404deef120
import:"@/lib/queries"#2=5fe4eaf28341f184b4099eeb
import:"@/lib/surgery-bridge"#1=feddd6fd4a6bdd4e5747350c
import:"@tabler/icons-react"#1=fc01b3bbb6dd9a85f3147f03
import:"@/components/intake/HistoricalDoseLauncher"#1=5198177fe515905a5f47a91d
import:"@/lib/dose-log-window"#1=c18746bc2e23c918617bd04e
VariableStatement:dynamic#1=2c333a385bf565c19065a40b
FunctionDeclaration:SupplementsTab#1=abe5b25451d6f80ae369ed5e
FunctionDeclaration:SupplementsTab#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:SupplementsTab#1>DefaultKeyword=82d4ba16d62f166ef3cb9fe0
FunctionDeclaration:SupplementsTab#1>AsyncKeyword=01406dca26728abf96db4fbc
FunctionDeclaration:SupplementsTab#1>Identifier=e97fe233b4a315aa7fa23cd3
FunctionDeclaration:SupplementsTab#1>Parameter=96edf1b42a65e2cb55e6d0e3
FunctionDeclaration:SupplementsTab#1>Block=45f190600d610850d026a2f0
`,
} as const;
const MEDICATIONS_TODAY_SHAPE = {
  digest: "5930b9b6c294eb6041f58746",
  trace: reviewedTrace`
import:"@tabler/icons-react"#1=ff04bedfbb0cd86f90a817e3
import:"@/components/intake/DoseLedgerLink"#1=8d5248d0800bf4f438a6f391
import:"@/components/medications/QuickLogPrnControl"#1=8beea76c89897a6737cfca5a
import:"@/components/medications/TodayMedRow"#1=9ac11fcd3834161351bf9d0d
import:"@/components/medications/ScheduledDoseAction"#1=57e36464c3ac1974c9efff25
import:"@/components/medications/MomentSlot"#1=dfa48fb508135732831839c9
import:"@/lib/hrefs"#1=581df912ef20a1371c83aabe
import:"@/lib/medication-today"#1=cefebd1772160018d47cb7e0
import:"@/lib/moment-sections"#1=2ed1420a45a8085d6ab1db01
import:"@/lib/intake-schedule"#1=18708e7de432e8c6132ef316
import:"@/lib/medication-dose-format"#1=9f6252e3b1d1b68616c6fc4a
import:"@/lib/administration-format"#1=83a42f2247192df0c4315c28
FunctionDeclaration:MedicationsTodayPanel#1=849a095387f1352a01f45b22
FunctionDeclaration:MedicationsTodayPanel#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:MedicationsTodayPanel#1>DefaultKeyword=82d4ba16d62f166ef3cb9fe0
FunctionDeclaration:MedicationsTodayPanel#1>Identifier=3bce0f42a89ea9e90f7da384
FunctionDeclaration:MedicationsTodayPanel#1>Parameter=3520b35d0231630ed9bf23e8
FunctionDeclaration:MedicationsTodayPanel#1>Block=e1d90bb72653b45e361bf618
`,
} as const;
const DASHBOARD_PLACEMENT_SHAPE = {
  digest: "a79778970e7739852bc85491",
  trace: reviewedTrace`
import:"react"#1=f9550bb0c39b7f1ffc0304fa
import:"@/components/ui"#1=7bb3c705e0f69e5be650e01f
import:"@/lib/dashboard-relevance"#1=9f8e436729dd3e6552865cd6
import:"./NowStrip"#1=82dff6d86f2fb0d673750c8f
import:"@/components/AppBadge"#1=5e6635e11bdf19612c92e098
import:"@/components/RememberedDetails"#1=2e232008a58270e10a163692
import:"./DashboardAhead"#1=e6a867e4c754101c10c003c2
import:"./DashboardStandingCluster"#1=01e5842ae55831d74694c912
VariableStatement:EVERYTHING_LABELS#1=645ce7e6db42c4c3f69d3946
FunctionDeclaration:groupsInPlacementOrder#1=0a85a110eb01f527bc020c64
FunctionDeclaration:DashboardPlacementCanvas#1=f0fde1ab6c79af5b08c91b33
FunctionDeclaration:DashboardPlacementCanvas#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:DashboardPlacementCanvas#1>DefaultKeyword=82d4ba16d62f166ef3cb9fe0
FunctionDeclaration:DashboardPlacementCanvas#1>Identifier=3047d4eed203d35e46d0f687
FunctionDeclaration:DashboardPlacementCanvas#1>Parameter=9e71e0da182f6b3cdb81bdae
FunctionDeclaration:DashboardPlacementCanvas#1>Block=18cfe4b57461cc2c35bae511
`,
} as const;
const MOUNT_DIGESTS = [
  [
    "44a11d29f49d32522e42f68a",
    "8a4e4745ab5f0d79b5f9336d",
    "2528c4f17826455acac5c546",
    RENDERER_3_SHAPE.digest,
    RENDERER_3_SHAPE.trace,
  ],
  [
    "5d8bea847046b94fffb12c58",
    "eb74a4186fe285d653b0f656",
    "8ae920a3f246df93a79344dc",
    MEDICATION_BOARD_SHAPE.digest,
    MEDICATION_BOARD_SHAPE.trace,
  ],
  [
    "5d8bea847046b94fffb12c58",
    "984bba90b5d0c6035a1aa84b",
    "944890619abb2eba8842529c",
    SUPPLEMENTS_SHAPE.digest,
    SUPPLEMENTS_SHAPE.trace,
  ],
  [
    "5d8bea847046b94fffb12c58",
    "c4149370e9e581eb9706a411",
    "c434e4878994c57e2420802c",
    SUPPLEMENTS_SHAPE.digest,
    SUPPLEMENTS_SHAPE.trace,
  ],
  [
    "1237b129ddcac61ead20e8e1",
    "21831083a01f21cb87d1b616",
    "09fdde3a65c949ff9c86b864",
    MEDICATIONS_TODAY_SHAPE.digest,
    MEDICATIONS_TODAY_SHAPE.trace,
  ],
  [
    "ecee40029fa1a7b92a6ce48f",
    "984bba90b5d0c6035a1aa84b",
    "944890619abb2eba8842529c",
    SUPPLEMENTS_SHAPE.digest,
    SUPPLEMENTS_SHAPE.trace,
  ],
  [
    "ecee40029fa1a7b92a6ce48f",
    "c4149370e9e581eb9706a411",
    "c434e4878994c57e2420802c",
    SUPPLEMENTS_SHAPE.digest,
    SUPPLEMENTS_SHAPE.trace,
  ],
  [
    "0f3971f0ed1929325413bbaa",
    "b94c20b59e22d6a0d5663fdb",
    "4ec326c9a706d104fbe7d07f",
    DASHBOARD_PLACEMENT_SHAPE.digest,
    DASHBOARD_PLACEMENT_SHAPE.trace,
  ],
  [
    "a549d2af570db42bf8257ed7",
    "8a4e4745ab5f0d79b5f9336d",
    "2528c4f17826455acac5c546",
    RENDERER_3_SHAPE.digest,
    RENDERER_3_SHAPE.trace,
  ],
] as const;
const PAGE_HEADER_SHAPE = {
  digest: "b42a228b0b3b6c65d882ba82",
  trace: reviewedTrace`
import:"next/link"#1=da9ec5d2cfb1e184473dcc0a
import:"@tabler/icons-react"#1=bc82fdddd9449af4d8adf022
import:"@/components/ActivityIcon"#1=1b920f4b611321b2c2350bc4
import:"@/components/PendingLink"#1=e552d3d12d603b2b77e58b0f
import:"@/lib/reference-range"#1=b7703f0adfa7887288638937
import:"@/lib/medical-value"#1=5493d7f6d4ab2378de98a34d
import:"@/lib/display-unit"#1=6d2745dd968cf2fdf58784a1
FunctionDeclaration:PageHeader#1=e3297cdcb039c61e632d5cac
FunctionDeclaration:PageHeader#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:PageHeader#1>Identifier=9bab6c60a286b2aa9d4f5ea8
FunctionDeclaration:PageHeader#1>Parameter=5b9541df34779c025272238c
FunctionDeclaration:PageHeader#1>Block=2a4418923b146280584e9613
FunctionDeclaration:StatCard#1=569e9417225182c5ec9ccd3d
FunctionDeclaration:EmptyState#1=05c144d5a06ca2ef8fc3f316
VariableStatement:typeColors#1=264b7281c9a1e90cab258810
FunctionDeclaration:Tag#1=ce6f917f9014a0a20db289db
FunctionDeclaration:medicalValueClass#1=b77fb051bca4907e54a087ae
FunctionDeclaration:MedicalValue#1=3acc720aacc089cd85dd2b0f
FunctionDeclaration:ActivityTypeIcon#1=4cd6e614effbb79d0cced30a
VariableStatement:INTENSITY_BADGE#1=ee521bb9a538a8be5cf5349b
FunctionDeclaration:IntensityBadge#1=93dd2959657bb1698c666ffa
`,
} as const;
const CARD_GROUP_SHAPE = {
  digest: "c7f5ea3b726884362a7d4abf",
  trace: reviewedTrace`
import:"@/components/InfoTooltipIcon"#1=1ea4b1b2e45e19d54eafa401
FunctionDeclaration:CardGroup#1=8704206000f4f5e560811833
FunctionDeclaration:CardGroup#1>ExportKeyword=a5ebe53925e881f5c83fb53f
FunctionDeclaration:CardGroup#1>DefaultKeyword=82d4ba16d62f166ef3cb9fe0
FunctionDeclaration:CardGroup#1>Identifier=2757591de828114fa64f2421
FunctionDeclaration:CardGroup#1>Parameter=fc72d25f378280b306e6c40c
FunctionDeclaration:CardGroup#1>Block=fdd5fa8f4988e639690429e3
FunctionDeclaration:CardGroupSection#1=1208b0e8bfac60b6515f3841
`,
} as const;
const HREFS_SHAPE = {
  digest: "986945a7c06221e41056781f",
  trace: reviewedTrace`
import:"./reading-cadence"#1=e3e899a7db28a8aaa68b6820
VariableStatement:NUTRITION_TABS#1=3861c1cb26846b8622adf946
FunctionDeclaration:nutritionTabHref#1=3fcb68e48a4fad4af43dd53f
VariableStatement:MEDICATIONS_HREF#1=8d0b5bc5e565c0539e9a1215
VariableStatement:RECORDS_CONDITIONS_HREF#1=11d37b8bd7b6ff5b9e4a3fd7
FunctionDeclaration:retrospectiveHref#1=478914480bb8d9a759475c31
VariableStatement:SUPPLIES_HREF#1=d2d8103a91f6d3a1bcc601c6
VariableStatement:EPISODES_HREF#1=eb476f46281f20dba4bb2e0b
FunctionDeclaration:episodesKindHref#1=ebacdb9bbf7d4b45ac059096
VariableStatement:INSTRUMENTS_HREF#1=3209f69a3a98886d9b31c072
FunctionDeclaration:intakeHref#1=0c2483886b50ed4401cbfef4
VariableStatement:DOSE_LEDGER_ALL_KINDS#1=e0d1246ef00702f4a36e0e12
FunctionDeclaration:doseLedgerHref#1=05a327e5830bbf50e99d0708
FunctionDeclaration:eventLedgerHref#1=ed6389fef66f5fd3e4e754bc
FunctionDeclaration:foodLedgerHref#1=22b35ebec8022fffa4edeb0f
FunctionDeclaration:practiceLedgerHref#1=f6d1a2fde7446d9b9e4eed62
VariableStatement:SUPPLY_PREFILL_PARAM#1=651502556a6afd26bf2267a2
FunctionDeclaration:addItemFromPoolHref#1=f82b720066dc103eddbd9632
VariableStatement:CLINICAL_RESULTS_LIST_HREF#1=1aa521dffa878cbd0ff1bc6a
FunctionDeclaration:episodicClinicalResultHref#1=9e8827b4f13b2074fcf1ddd8
FunctionDeclaration:clinicalResultDetailHref#1=b6c21b6d63054a73cacd75b0
FunctionDeclaration:clinicalResultPanelHref#1=49fc67e76134d990aa22e45d
FunctionDeclaration:clinicalResultAddHref#1=798db502d4c6380e4fea01a1
VariableStatement:MEDICATION_FILTERS#1=7af619c96e6d50eccfc10983
FunctionDeclaration:medicationsFilterHref#1=6c85ab1a3deeb866791d0b19
FunctionDeclaration:trainingActivityPageHref#1=a28a1bbb67873bee8984b9ca
FunctionDeclaration:timelineDayHref#1=4dde4266cbfaf4434d9ee000
FunctionDeclaration:timelineRangeHref#1=872f1c18634bfaab562d8550
FunctionDeclaration:trainingLogDayHref#1=6b7f7b1a1b625afa64ed4225
FunctionDeclaration:dayHistoryAddHref#1=0c1deb0347827e1385250794
VariableStatement:DATA_SECTIONS#1=8648179ebce00898ae83b060
FunctionDeclaration:dataSectionHref#1=03b8c93f759c56b4ec2d507d
VariableStatement:INTEGRATION_DETAIL_ROUTES#1=87ceae54dcff8ef2d3a0bb0a
FunctionDeclaration:integrationDetailHref#1=02015cd70d54f526a20d4dfc
FunctionDeclaration:currentPathHref#1=8dae22a6753885490cfe881d
FunctionDeclaration:importHref#1=22eff00f6b22997fd50c5c98
FunctionDeclaration:importTabHref#1=cc0e75f9c8e8df734b4ef287
FunctionDeclaration:encounterHref#1=3a6292696366bc3793bdde05
FunctionDeclaration:providerHref#1=40265eea7fddb6abce78475f
FunctionDeclaration:medicationHref#1=ca5d4e2ba2ca6c071d366c91
FunctionDeclaration:medicationEditHref#1=781f8e9764d47c760dd689ce
FunctionDeclaration:equipmentHref#1=ccd5c70c3e6a55670c0db640
VariableStatement:PRACTICES_HREF#1=261c775eec2d910fdcc68ace
FunctionDeclaration:protocolHref#1=53359f1db7edbda89486ad00
FunctionDeclaration:cyclingRideHref#1=018fd3234eaa98cfc245a71e
FunctionDeclaration:strengthAnalyzeHref#1=145d0ec239f95d6f950525a2
FunctionDeclaration:cyclingOverviewHref#1=1faaefa70efba6a45b58af33
VariableStatement:CYCLING_OVERVIEW_HREF#1=7bf8c1a61026b75752986d99
FunctionDeclaration:immunizationHref#1=0cd511f413843b831086cdef
FunctionDeclaration:metricDetailHref#1=88dab6198a17f34f8a5ae389
VariableStatement:GROWTH_TRENDS_HREF#1=c06b753297bb90abfc49e201
FunctionDeclaration:growthTrendsHref#1=79d0f9dd97bd0916c8bbf25e
FunctionDeclaration:episodeHref#1=3664efd7c59c62ac460e8c68
`,
} as const;
const RECENT_PAGES_SHAPE = {
  digest: "2cbfc690f66643b0afb92fdf",
  trace: reviewedTrace`
VariableStatement:TRACKED_PAGES#1=abcf70a51ab64f97d299c145
VariableStatement:PAGE_VISITS_KEY#1=fb62a7a50692874ea294af2c
VariableStatement:MAX_TRACKED#1=ad04d5ad17dc071aebd05730
VariableStatement:FREQUENT_LIMIT#1=b4b9054939231ab610c5e8fb
VariableStatement:FREQUENT_MIN_VISITS#1=3b84beb2273c3bc9a910caf4
FunctionDeclaration:trackedPageFor#1=cf9f84e149525a4fd43a44f1
FunctionDeclaration:recordPageVisit#1=e03c4a060c3266db8ce280a7
FunctionDeclaration:frequentPages#1=4593d442df733f797497c9cc
FunctionDeclaration:parsePageVisits#1=cfd58111700c513249f30fa3
`,
} as const;
const REFILL_SHAPE = {
  digest: "c591cf942b52630e209ece0a",
  trace: reviewedTrace`
import:"./date"#1=3639d03e70f82a365ad67742
VariableStatement:DEFAULT_LOW_SUPPLY_DAYS#1=95936c61184c83e6e1351b28
VariableStatement:RATE_WINDOW_DAYS#1=35b10507e16e052744bdd78d
VariableStatement:MIN_HISTORY_DAYS#1=3628476add64b42c36256191
FunctionDeclaration:consumptionRate#1=e29bd56bda40150027f50469
FunctionDeclaration:refillBasisLabel#1=5cd9c37c8a968c4e26040dbe
FunctionDeclaration:unitsPerDay#1=94a68017054a3bd9ceb52ad0
FunctionDeclaration:daysOfSupplyLeft#1=ddab931269c1e071a9e0ddb2
FunctionDeclaration:isLowSupply#1=ae1d067277a4afc8ed726029
FunctionDeclaration:daysOfSupplyForItem#1=e2f6c15245fc95c20a36d488
FunctionDeclaration:pooledUnitsPerDay#1=69d24b9f7c37c15015cf2112
FunctionDeclaration:daysOfSupplyForPool#1=8322632d6e3ad54b35492e1d
FunctionDeclaration:resolvePoolUnlinkRestore#1=f91d1995b3994b7d6c21c547
FunctionDeclaration:isPoolVisibleTo#1=b98f79ef4b67f25aaefc95c6
FunctionDeclaration:sharedSuppliesLinkLabel#1=98c8669d001102757f58d903
FunctionDeclaration:parseQuantityOnHand#1=2527caafd8b3502d0d5d7bba
FunctionDeclaration:resolveOnHandWrite#1=56cd971b0cec61b8d70d4fe5
FunctionDeclaration:resolveRefillWrite#1=2d14e49361549703a02c4a12
FunctionDeclaration:runOutDateStr#1=daee36b6a50ef90cc0a1815e
FunctionDeclaration:selectLowSupplyItems#1=6b77294ff947762675b08a50
`,
} as const;
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
function rendererSupportDigests(
  index: number
): Readonly<Record<string, string>> {
  return index === 3
    ? {
        doorLabel: "c6cf47ac0eb3fc32569abefb",
        SECTIONS: "c6253898e441a800a67bc7af",
      }
    : {};
}
const REGISTRY: DestinationDoorRegistry = {
  descriptorVersion: "door-ast-token-v3",
  typescriptVersion: "5.9.3",
  renderers: PLAN.renderers.map((entry, index) => ({
    ...entry,
    declarationDigest: RENDERER_SHAPES[index].digest,
    supportDigests: rendererSupportDigests(index),
    declarationTrace: RENDERER_SHAPES[index].trace,
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
      declarationDigest: PAGE_HEADER_SHAPE.digest,
      declarationTrace: PAGE_HEADER_SHAPE.trace,
    },
    {
      ...PLAN.trustedSlots[1],
      declarationDigest: CARD_GROUP_SHAPE.digest,
      declarationTrace: CARD_GROUP_SHAPE.trace,
    },
  ],
  externalModules: [
    {
      key: "external:lib/hrefs.ts",
      path: "lib/hrefs.ts",
      moduleDigest: HREFS_SHAPE.digest,
      moduleTrace: HREFS_SHAPE.trace,
    },
    {
      key: "external:lib/recent-pages.ts",
      path: "lib/recent-pages.ts",
      moduleDigest: RECENT_PAGES_SHAPE.digest,
      moduleTrace: RECENT_PAGES_SHAPE.trace,
    },
    {
      key: "external:lib/refill.ts",
      path: "lib/refill.ts",
      moduleDigest: REFILL_SHAPE.digest,
      moduleTrace: REFILL_SHAPE.trace,
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
    'const key = "requ" + "ire"; module[key]("./door")',
    'const key = `requ${"ire"}`; globalThis[key]("./door")',
    'let key = "require"; globalThis[key]("./door")',
    '(0, module["requ" + "ire"])("./door")',
    'module["requ" + "ire"].bind(null)("./door")',
    'import { createRequire } from "node:module";',
    'import { createRequire as makeRequire } from "module";',
    'import * as moduleApi from "node:module";',
    'import moduleApi from "module";',
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

  it.each([
    "function require() {} require('./door')",
    "function run(require: (path: string) => void) { require('./door'); }",
    "{ const require = () => null; require('./door'); }",
    "function run() { if (ok) { var require = local; } require('./door'); }",
    "try {} catch (require) { require('./door'); }",
    "const module = { require() {} }; module.require('./door');",
    "const createRequire = () => null; createRequire();",
    'import { require } from "./benign"; require("./door");',
    'switch (kind) { case "local": const require = local; require("./door"); break; }',
  ])("respects lexical loader shadowing: %s", (source) => {
    expect(
      new DestinationDoorCorpus([{ path: "lib/shadow.ts", source }]).findings
    ).toEqual([]);
  });

  it("ignores loader spellings used only by the type system", () => {
    expect(
      new DestinationDoorCorpus([
        {
          path: "lib/types.ts",
          source: [
            "type RequireType = typeof require;",
            "type CreateRequireType = typeof createRequire;",
            "type ModuleRequireType = typeof module.require;",
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

  it("reviews imported support and top-level execution", () => {
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

  it("reviews every runtime top-level shape without name-based dependencies", () => {
    const source = [
      'import Link from "next/link";',
      'const UNUSED = sideEffect("baseline");',
      "class Support { static value = 1; static { register(this); } }",
      "export default function Door({ href }: { href: string }) {",
      "return <Link href={href}>Door</Link>;",
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
    expect(
      baseline.renderers[0].declarationTrace.filter((entry) =>
        entry.startsWith("import:")
      )
    ).toEqual(['import:"next/link"#1=da9ec5d2cfb1e184473dcc0a']);
    for (const mutation of [
      source.replace('sideEffect("baseline")', 'sideEffect("changed")'),
      source.replace("static value = 1", "static value = 2"),
      source.replace("register(this)", "register(other)"),
      source.replace(
        "export default function Door",
        'const EXTRA = sideEffect("extra");\nexport default function Door'
      ),
    ]) {
      expect(
        auditDestinationDoorRegistry(
          new DestinationDoorCorpus([
            { path: "components/Door.tsx", source: mutation },
          ]),
          baseline
        )
      ).toEqual([expect.objectContaining({ key: "renderer:door" })]);
    }
    const shadowMutation = source
      .replace("{ href }: { href: string }", "{ href, UNUSED }: any")
      .replace('sideEffect("baseline")', 'sideEffect("changed")');
    expect(
      auditDestinationDoorRegistry(
        new DestinationDoorCorpus([
          { path: "components/Door.tsx", source: shadowMutation },
        ]),
        baseline
      )
    ).toEqual([expect.objectContaining({ key: "renderer:door" })]);
  });

  it("pins empty named import and export module-shape edges in every mode", () => {
    const edges = [
      'import {} from "edge-a";',
      'import type {} from "edge-b";',
      'export {} from "edge-c";',
      'export type {} from "edge-d";',
    ];
    const source = [
      ...edges,
      "export default function Door() { return <div />; }",
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
    for (const edge of edges) {
      expect(
        auditDestinationDoorRegistry(
          new DestinationDoorCorpus([
            {
              path: "components/Door.tsx",
              source: source.replace(`${edge}\n`, ""),
            },
          ]),
          baseline
        ),
        edge
      ).toEqual([expect.objectContaining({ key: "renderer:door" })]);
    }
  });

  it("uses stable kind-and-ordinal selectors across comment-only prefixes", () => {
    const source = [
      'import Link from "next/link";',
      'export default function Door() { return <Link href="/door">Door</Link>; }',
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
    expect(
      auditDestinationDoorRegistry(
        new DestinationDoorCorpus([
          { path: "components/Door.tsx", source: `// context only\n${source}` },
        ]),
        baseline
      )
    ).toEqual([]);
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

  it("counts aliased IconChevronRight bindings", () => {
    const source =
      'import { IconChevronRight } from "@tabler/icons-react"; export function Row() { return <button><IconChevronRight /></button>; }';
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
    const mutation = source
      .replace(
        "IconChevronRight }",
        "IconChevronRight, IconChevronRight as ExtraChevron }"
      )
      .replace("</button>", "<ExtraChevron /></button>");
    expect(
      auditDestinationDoorRegistry(
        new DestinationDoorCorpus([
          { path: "components/Row.tsx", source: mutation },
        ]),
        baseline
      ).map((finding) => finding.key)
    ).toEqual(
      expect.arrayContaining(["non-door:reason-key-set", "non-door:signature"])
    );
  });

  it("allows direct JSX aliases but rejects chevron value aliases and barrels", () => {
    const source =
      'import { IconChevronRight as Chevron } from "@tabler/icons-react"; export function Row() { return <button><Chevron /></button>; }';
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
    expect(
      auditDestinationDoorRegistry(
        new DestinationDoorCorpus([{ path: "components/Row.tsx", source }]),
        baseline
      )
    ).toEqual([]);

    const aliasMutation = source
      .replace("export function", "const Other = Chevron; export function")
      .replace("<Chevron />", "<Other />");
    expect(
      auditDestinationDoorRegistry(
        new DestinationDoorCorpus([
          { path: "components/Row.tsx", source: aliasMutation },
        ]),
        baseline
      ).map((finding) => finding.key)
    ).toContain("chevron:value-use");

    const barrel = new DestinationDoorCorpus([
      {
        path: "components/icons.ts",
        source:
          'export { IconChevronRight as Chevron } from "@tabler/icons-react";',
      },
    ]);
    const barrelRegistry = captureDestinationDoorRegistry(barrel, {
      renderers: [],
      mounts: [],
      trustedSlots: [],
      nonDoorReasons: {},
    });
    expect(
      auditDestinationDoorRegistry(barrel, barrelRegistry).map(
        (finding) => finding.key
      )
    ).toContain("chevron-re-export");
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
