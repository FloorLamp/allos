// Shared utilities whose compiled declarations are intentionally phone-only.
// Register the utility here when its design-system contract says it contributes
// nothing at `sm` or above. The declaration floors make a missing/renamed rule
// fail loudly before an empty desktop scan can be believed (#3518/#3509).
export const PHONE_ONLY_UTILITIES = [
  { name: "subpanel-inset", minDeclarations: 1, properties: ["padding"] },
  { name: "subpanel-inset-sm", minDeclarations: 1, properties: ["padding"] },
  { name: "subpanel-inset-xs", minDeclarations: 1, properties: ["padding"] },
  { name: "section-seam", minDeclarations: 1, properties: ["margin-bottom"] },
  {
    name: "section-seam-lg",
    minDeclarations: 1,
    properties: ["margin-bottom"],
  },
  {
    name: "section-stack",
    minDeclarations: 3,
    properties: ["margin-block-start", "margin-block-end"],
  },
  {
    name: "section-stack-sm",
    minDeclarations: 3,
    properties: ["margin-block-start", "margin-block-end"],
  },
  {
    name: "table-cards",
    minDeclarations: 60,
    properties: ["display", "flex-wrap", "padding"],
  },
  {
    name: "table-section-row",
    minDeclarations: 5,
    properties: ["display", "padding"],
  },
  {
    name: "table-nested-row",
    minDeclarations: 1,
    properties: ["padding-block"],
  },
  {
    name: "metric-readings-list",
    minDeclarations: 20,
    properties: ["flex-basis", "content", "inset"],
  },
  {
    name: "practice-session-list",
    minDeclarations: 6,
    properties: ["padding-inline", "flex-basis"],
  },
  {
    name: "notification-kind-matrix",
    minDeclarations: 30,
    properties: ["display", "order", "padding"],
  },
];

// Measured from the deterministic compiled registry, not source spelling: 156
// at the establishing head. Slack permits ordinary Tailwind output changes while an
// empty or badly under-read census still fails closed.
export const PHONE_DECLARATION_FLOOR = 140;
export const COMPILED_BYTE_FLOOR = 15_000;
export const PHONE_BLOCK_FLOOR = 4;
