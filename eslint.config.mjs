import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

const TYPESCRIPT_API_PATTERN = {
  group: ["typescript", "typescript/*"],
  message:
    'Import the compiler API from "typescript-api" (the pinned 5.x alias), not from "typescript" — see #3559.',
};

// ESLint 9 flat config. `next lint` is deprecated in Next 15 and removed in 16,
// so `npm run lint` drives the ESLint CLI directly (see package.json). The lint
// surface is `eslint-config-next`'s `next/core-web-vitals` rule set, applied to
// every tracked JavaScript and TypeScript source file from the repository root.
//
// eslint-config-next 16 ships a NATIVE flat-config export (a `Linter.Config[]`),
// so we consume it directly. This replaces the `@eslint/eslintrc` FlatCompat
// bridge we needed on 15.x (which only shipped classic `.eslintrc` configs) —
// FlatCompat.extends("next/core-web-vitals") throws a "circular structure"
// error against the 16.x native flat config, so the bridge is gone.
// The brand names lib/temporal-types.ts exports — the cast ban below is keyed on them.
const TEMPORAL_BRANDS = [
  "LocalDay",
  "LocalTime",
  "CanonicalInstant",
  "BareInstant",
];
// #5348 — lib/auth.ts's write-authorization brand. Same seam, same shapes: it is
// minted by the three write gates and by nothing else, so the cast is the one forge
// tsc cannot refuse. One name, run through the SAME builder as the temporal brands
// rather than a second hand-written selector — a cast ban that only covers
// `x as Brand` is walked past by `type B = Brand; x as B`.
const WRITE_BRANDS = ["WriteAuthorizedProfileId"];
// The shapes a cast to a brand can take, by NAME — this rule is syntactic and does
// not chase what a name resolves to (lib/temporal-types.ts says what that leaves to
// review). `.typeAnnotation` pins a match to the cast's TYPE side, so a brand inside
// the expression being cast (`foo<LocalDay>() as string`) is not this rule's business;
// the `:not(TSTypeLiteral …)` clause is the row-shape exemption.
const brandCastSelectors = (brands) => {
  const cast = ":matches(TSAsExpression, TSTypeAssertion)";
  const names = `/^(?:${brands.join("|")})$/`;
  // A reference to a brand by bare name, qualified name (`TT.LocalDay`) or
  // `import("…").LocalDay`.
  const ref = `:matches(TSTypeReference[typeName.name=${names}], TSTypeReference[typeName.right.name=${names}], TSImportType[qualifier.name=${names}])`;
  return [
    // `s as LocalDay`, `<LocalDay>s`, `s as unknown as LocalDay`.
    `${cast} > ${ref}.typeAnnotation`,
    // The brand anywhere inside the cast's type — a union, array, tuple, intersection,
    // `NonNullable<>`, `Readonly<>`, `Array<>` — except inside an object type literal.
    `${cast} > *.typeAnnotation ${ref}:not(TSTypeLiteral ${ref})`,
    // `type D = LocalDay`, `type D = LocalDay & {}`, `type Ds = LocalDay[]` — an alias
    // that mentions a brand outside an object shape exists only to cast around the
    // rule. `type Row = { d: LocalDay }` is a row shape and stays allowed.
    `TSTypeAliasDeclaration > ${ref}.typeAnnotation`,
    `TSTypeAliasDeclaration > *.typeAnnotation ${ref}:not(TSTypeLiteral ${ref})`,
    // `type G<T = LocalDay> = T` — the brand named in an alias's type parameters
    // rather than its body.
    `TSTypeAliasDeclaration > TSTypeParameterDeclaration ${ref}`,
    // `import { LocalDay as LD }` / `export { LocalDay as LD }` — renaming a brand
    // takes its name out of every selector above. Covers the ES2022 string-literal
    // spelling (`import { "LocalDay" as LD }`) and `import LD = TT.LocalDay`.
    `:matches(ImportSpecifier, ExportSpecifier)[imported.name=${names}]:not([local.name=${names}])`,
    `:matches(ImportSpecifier, ExportSpecifier)[imported.value=${names}]`,
    `ExportSpecifier[local.name=${names}]:not([exported.name=${names}])`,
    `ExportSpecifier[local.value=${names}]`,
    `TSImportEqualsDeclaration > TSQualifiedName.moduleReference[right.name=${names}]`,
  ];
};
const TEMPORAL_BRAND_CAST_SELECTORS = brandCastSelectors(TEMPORAL_BRANDS);
const WRITE_BRAND_CAST_SELECTORS = brandCastSelectors(WRITE_BRANDS);

// ── The scanners that used to reread the tree ────────────────────────────────
//
// Everything from here to the config array is an invariant that used to live in a
// Vitest file walking `lib/`, `app/` and `components/` with its own `readdirSync`
// and matching source text by regex (#5346/#5347). Each is a SYNTAX shape with no
// type surface, so it belongs on the parse ESLint already runs; the scans' own
// same-line reason markers become `// eslint-disable-next-line <rule> -- <reason>`
// and their per-file allowlists become `files`/`ignores` overrides.
//
// ONE MECHANIC GOVERNS ALL OF THEM, and getting it wrong is silent: a flat config
// REPLACES a rule's options rather than merging them, so a narrower `files` block
// switches OFF every ban an earlier block put on the same rule for those files. The
// accumulating constants below are the fix — each block spreads the level it sits
// inside — and a block that `ignores` a file leaves that file on the level above,
// which is why the temporal-brand block stays first and broadest.

// Test tiers are not shipped surfaces: a fixture may name anything it is asserting
// about. Every scan replaced below excluded them.
const TEST_TREES = [
  "**/__tests__/**",
  "**/__db_tests__/**",
  "**/__action_tests__/**",
  "**/*.test.ts",
  "**/*.test.tsx",
];
// The last two entries are Next's repo-root modules: middleware.ts runs on every
// request and instrumentation-client.ts in every browser session, and no `**/` tree
// reached either, so both sat outside every ban composed onto this list — the #5348
// write-brand cast included (#5856). EXPORTED because
// lib/__tests__/write-brand-ban-coverage.ts enumerates the production surface from
// this list rather than restating it.
export const PRODUCTION_TREES = [
  "lib/**/*.{ts,tsx}",
  "app/**/*.{ts,tsx}",
  "components/**/*.{ts,tsx}",
  "scripts/**/*.{ts,tsx}",
  "middleware.ts",
  "instrumentation-client.ts",
];
// The one module allowed to expose the raw `revalidatePath`, so it is in `ignores`
// on every block below that carries REVALIDATE_PATH_BAN — and an `ignores` entry
// drops a file to the level above for every rule that block sets, not just the one
// it was exempted from. The block near the end of the config hands its
// `no-restricted-syntax` level back (#5856).
const REVALIDATE_MODULE = "lib/revalidate.ts";

// #1636/#2149 — was inline in the revalidate block below; named here so the blocks
// added after it can re-state it (see the mechanic above).
const REVALIDATE_PATH_BAN = {
  name: "next/cache",
  importNames: ["revalidatePath"],
  message:
    "Use revalidateRoute from lib/revalidate.ts so the target remains compile-checked (#1636/#2149).",
};

// #3335 — the RPE opt-in seam. `RpeTracking` is minted on one branch of one module,
// so exactly one production module may import the minter and nothing may cast past
// the brand. (was lib/__tests__/rpe-opt-in.test.ts)
const RPE_MINTER_BAN = {
  name: "@/lib/rpe",
  importNames: ["mintRpeTracking"],
  message:
    "Only lib/rpe-tracking.ts mints an RpeTracking — a second producer is the drift the opt-in seam exists to prevent (#3335).",
};
const RPE_BRAND_CAST = {
  selector:
    ":matches(TSAsExpression, TSTypeAssertion) > TSTypeReference[typeName.name='RpeTracking'].typeAnnotation",
  message:
    "Do not cast to RpeTracking. Obtain it from mintRpeTracking, which is reached only when the profile opted in (lib/rpe.ts, #3335).",
};
// #5348 — the write-authorization seam, the RPE seam's twin one level up.
// `WriteAuthorizedProfileId` is minted by `requireWriteAccess`, `requireProfileWriteAccess`
// and `requireAdmin` in lib/auth.ts and by nothing else — the brand symbol is not
// exported, so a CAST is the only way production code can hand a write core an id no
// gate ever checked, and tsc cannot refuse one. A test tier may cast: a db or action
// fixture has no request to gate, and exporting a minter for it would put the mint in
// two places, which is what the seam exists to prevent.
const WRITE_BRAND_CAST = WRITE_BRAND_CAST_SELECTORS.map((selector) => ({
  selector,
  message:
    "Do not cast or re-alias to WriteAuthorizedProfileId. Take it from a write gate's session: requireWriteAccess(), requireProfileWriteAccess(id) and requireAdmin() return it as `writeProfileId` (lib/auth.ts, #5348).",
}));
// The one file that mints it, and so the one file that keeps the cast.
const WRITE_BRAND_MINTER = "lib/auth.ts";

// The stored key is an identity: two spellings of it would be two opt-ins.
const RPE_KEY_LITERAL = [
  {
    selector: "Literal[value='strength_rpe']",
    message:
      "The RPE opt-in key is spelled once, in lib/rpe-tracking.ts — import RPE_TRACKING_KEY (#3335).",
  },
  {
    selector: "TemplateElement[value.raw=/strength_rpe/]",
    message:
      "The RPE opt-in key is spelled once, in lib/rpe-tracking.ts — import RPE_TRACKING_KEY (#3335).",
  },
];

// #1935/#1936/#1937/#1939/#1966 — one streak computation survives and one module may
// call it. A new caller has to state which "you have done too much of this in a row"
// question it answers; a run to MAINTAIN is not one of them.
// (was lib/__tests__/streak-scope.test.ts)
const STREAK_MODULE_BAN = {
  group: ["**/streak"],
  message:
    'lib/streak answers the overtraining question only. A new caller must say which "you have done too much of this in a row" question it asks — a run to MAINTAIN is not one (#1935/#1936/#1937/#1939/#1966).',
};

// #1049 — the disclaimer copy is consolidated onto /disclaimer and footer-linked from
// every page, so a domain surface deletes its inline disclaimer rather than importing
// the constant. (was the import half of lib/__tests__/disclaimers.test.ts)
const DISCLAIMERS_BAN = {
  name: "@/lib/disclaimers",
  message:
    "The disclaimer lives on /disclaimer and is footer-linked from every page — delete the inline disclaimer rather than importing the copy (#1049).",
};

// #1069 — a vendor's own daily score is a store-what-the-source-said display value.
// Nothing may COMPUTE with one, so only the display/ingest surfaces may name the kinds,
// by literal or by the exported constant. The two vendors keep SEPARATE allowlists (a
// Sleep-page query may name an Oura kind and still not an imported Fitbit one), which
// is why three blocks below and not one.
// (was lib/__tests__/vendor-score-engine-inert.test.ts)
const vendorScoreBan = (vendor, names) =>
  [
    // ANCHORED, and the two literal forms below are not: a longer IDENTIFIER is a
    // different symbol (`ouraSleepScoreLabel` is not the kind), so prefix-matching
    // identifiers would fire on unrelated names. A longer STRING containing the key is
    // the key plus a suffix — `oura_sleep_score_v2` is still a vendor score key — so the
    // quote and the backtick spellings must ban the same twenty characters. They did not
    // until #5347: the string was legal and the template was not.
    `Identifier[name=/^(?:${names.join("|")})$/]`,
    `Literal[value=/(?:${names.join("|")})/]`,
    `TemplateElement[value.raw=/(?:${names.join("|")})/]`,
  ].map((selector) => ({
    selector,
    message: `${vendor}'s own daily score is displayed attributed and feeds NO engine — not the pillars, not coaching, not the digest, not risk/cadence (#1069).`,
  }));
const OURA_SCORE_KINDS = vendorScoreBan("Oura", [
  "oura_sleep_score",
  "oura_readiness_score",
  "OURA_SLEEP_SCORE_METRIC",
  "OURA_READINESS_SCORE_METRIC",
]);
const FITBIT_SCORE_KINDS = vendorScoreBan("Fitbit", [
  "fitbit_sleep_score",
  "fitbit_readiness_score",
  "FITBIT_SLEEP_SCORE_METRIC",
  "FITBIT_READINESS_SCORE_METRIC",
]);
// Each a display/ingest/bounds surface, never an engine that derives a decision.
const OURA_SURFACES = [
  // Definitions + the pure parser that mints the samples.
  "lib/integrations/oura.ts",
  // The sync that ingests the two daily-score endpoints into metric_samples.
  "lib/integrations/oura-sync.ts",
  // Plausibility bounds (0-100) — storage hygiene, not synthesis.
  "lib/ingest-bounds.ts",
  // The SOLE read path: the Sleep page's display query.
  "lib/queries/sleep.ts",
  // The display surfaces (Sleep page + its attributed tiles).
  "app/(app)/sleep/page.tsx",
  "app/(app)/sleep/OuraScores.tsx",
];
const FITBIT_SURFACES = [
  // Definitions + the pure parser that mints the samples.
  "lib/integrations/fitbit-takeout.ts",
  // Plausibility bounds (0-100) — storage hygiene, not synthesis.
  "lib/ingest-bounds.ts",
  // The DECLARATION of which streams only a Takeout archive can deliver (#2164). It is
  // DATA, not code: a literal array with type-only imports, where the kinds appear only
  // as the `metric` selector saying WHICH ROWS to look at. Its reader asks MAX(date) and
  // selects no `value` column, so the ask is a fact about DELIVERY, never about what
  // Fitbit scored.
  "lib/integrations/registry.ts",
];

// ── The Tailwind/JSX scanners (#5347 slice 2) ────────────────────────────────
//
// Each of these was a Vitest file matching class strings or JSX text by regex over
// app/ and components/ (lib/ too, for the contrast pair). Only the guards with a
// recorded catch or a shipped user-visible defect behind them moved here; the
// design-system censuses with neither were deleted under the 2026-09-06 ruling on
// #5346. A grandfathered file is a `files` override below, never a disable comment.

// A class-string ban applies to both spellings of a literal.
const classLiteral = (pattern) =>
  `:matches(Literal[value=${pattern}], TemplateElement[value.raw=${pattern}])`;

// #794 8a — the muted secondary-text pairing that fails WCAG in BOTH modes
// (slate-400 on white 2.56:1, slate-500 on ink-950 4.18:1); the passing pairing is
// `text-slate-500 dark:text-slate-400`. Base tokens only — a `placeholder:`,
// `disabled:` or `hover:` variant is a different affordance. No exemptions: there is
// no correct place for base muted text at that contrast. Caught #814's onboarding
// surfaces. (was lib/__tests__/muted-text-contrast.test.ts)
const MUTED_TEXT_CONTRAST = [
  String.raw`/(?<![\w:-])text-slate-400(?:\s+\S+)*\s+dark:text-slate-500(?![\w-])/`,
  String.raw`/dark:text-slate-500(?:\s+\S+)*\s+(?<![\w:-])text-slate-400(?![\w-])/`,
].map((pattern) => ({
  selector: classLiteral(pattern),
  message:
    "text-slate-400 dark:text-slate-500 fails WCAG in both modes (2.56:1 light, 4.18:1 dark) — muted text is text-slate-500 dark:text-slate-400 (#794).",
}));

// #794 9a — one grey-border language. A structural grey border speaks the alpha pair
// (`border-black/10 dark:border-white/10`, `/5` for a subtle divider), which is what
// .card/.input/.btn-ghost use; literal border-slate-{100,200} was the second
// vocabulary #794 swept. Caught #662's palette hit-action chips. The exemptions are
// the NEUTRAL members of a semantic tone set — a grey sibling of tinted tones, where
// slate is the tone rather than chrome — restated in the converse blocks below.
// (was lib/__tests__/border-alpha-language.test.ts, which read .tsx only; the .ts tone
// map in components/fitness-heat.ts is the same shape and joins the exemptions)
const BORDER_SLATE_BAN = {
  selector: classLiteral(
    String.raw`/(?<![\w-])border(?:-[xytblr])?-slate-(?:100|200)(?![\w-])/`
  ),
  message:
    "A structural grey border is the alpha pair — border-black/10 dark:border-white/10, or /5 for a subtle divider — not a literal border-slate-{100,200} (#794). A grey member of a tinted tone set is exempted by file in eslint.config.mjs.",
};

// #794 4+8b — the tinted message block is <Notice>. Its signature is a bordered
// tint, `border-{tone}-{200,300}` with a SOLID `bg-{tone}-50`, over every
// NOTICE_TONE key (#833 widened it from three tones to six); hand-rolled copies had
// drifted on border weight, radius, dark treatment and contrast (amber-600 on
// amber-50 is 3.07:1). A hover state, a `fixed` toast or a `rounded-full` pill
// wearing the tint is not a message block, and a `/60` tint is a panel. Caught
// #955's fitness-check timer tint. NOTICE_TONE itself and the trend chip's map are
// exempt below. (was lib/__tests__/notice-block.test.ts)
const NOTICE_TONE = "(?:amber|rose|slate|emerald|sky|violet)";
const NOT_A_NOTICE = String.raw`/hover:bg-|(?<![\w-])fixed(?![\w-])|rounded-full/`;
const noticeSignature = (field) =>
  `[${field}=/border-${NOTICE_TONE}-(?:200|300)(?![\\w-])/][${field}=/(?<![:\\w-])bg-${NOTICE_TONE}-50(?![\\w\\x2F])/]`;
const NOTICE_BLOCK_BAN = {
  // A template literal is judged WHOLE: `fixed ${layer} … border-rose-300 bg-rose-50`
  // is one toast even though its tokens land in different quasis.
  selector: `:matches(Literal${noticeSignature("value")}:not([value=${NOT_A_NOTICE}]), TemplateLiteral:not(:has(TemplateElement[value.raw=${NOT_A_NOTICE}])) > TemplateElement${noticeSignature("value.raw")})`,
  message:
    "A bordered tinted message block is <Notice tone=…> (or NOTICE_TONE / FindingCard), not a hand-rolled border-{tone}-{200,300} bg-{tone}-50 (#794).",
};
// The two tone maps own both the notice signature and a slate tone.
const NOTICE_TONE_MAPS = [
  "components/Notice.tsx",
  "components/TrendDigestChip.tsx",
];
// Slate as the neutral member of a tinted tone set, on the lib/app level…
const SLATE_TONE_SIBLINGS = [
  // The 'info' finding tone beside the amber 'warning' tone (#1496).
  "components/FindingRow.tsx",
  // The uncovered-gap status border beside the emerald 'covered' branch.
  "components/CoverageGaps.tsx",
  // The HeatTone tile map's neutral bucket beside five tinted ones (#1132).
  "components/fitness-heat.ts",
];
// …and the one on the training level: the rollup row wrapping FindingRow (#1496).
const SLATE_TONE_SIBLING_TRAINING = "app/(app)/training/TrainingWatchCard.tsx";

// #794 6 — every rendered <table> has a narrow-viewport strategy. <main> clips
// horizontal overflow, so a table wider than a phone silently loses its rightmost
// columns: no scrollbar, no hint, the data unreachable. A strategy is an ANCESTOR
// scroll container in the same file (`overflow-x-auto`, or the `overflow-auto`
// sticky-header wrappers), <ScrollFade>, or <ResponsiveTable>, which stacks the same
// DOM as cards below `sm` (#1426). The retired scan accepted a marker anywhere in
// the 800 characters above the tag; asking for an ancestor means a wrapper around a
// SIBLING no longer excuses a table (#1491 guard 12b's shape).
// (was lib/__tests__/table-mobile-scroll.test.ts)
const OVERFLOW_WRAPPER = "/overflow-(?:x-)?auto/";
const UNWRAPPED_TABLE_BAN = {
  selector: `JSXOpeningElement[name.name='table']:not(JSXElement[openingElement.name.name=/^(?:ScrollFade|ResponsiveTable)$/] JSXOpeningElement):not(JSXElement:has(> JSXOpeningElement:has(> JSXAttribute[name.name='className']:has(:matches(Literal[value=${OVERFLOW_WRAPPER}], TemplateElement[value.raw=${OVERFLOW_WRAPPER}])))) JSXOpeningElement)`,
  message:
    'A <table> with no narrow-viewport strategy clips its columns on a phone (#794). Render it through <ResponsiveTable> (cards below sm, #1426), or put <div className="overflow-x-auto"> / <ScrollFade> around it in this file.',
};
// The card-stacking primitive IS the strategy: it emits the `<table className=
// "table-cards">` the CSS re-lays below `sm`, so it cannot wrap itself in a scroller.
const TABLE_PRIMITIVE = "components/ResponsiveTable.tsx";

// #1447 — spacing around an inline span in rendered copy. The all-pages census found
// "At minimaldetail", "A read-onlygrant", and the space was in the source every time:
// the server render drops the leading space of a text node that follows an element
// or expression when that node also carries an HTML entity. So the TRIGGER is banned
// — write ’ “ ” as the characters themselves (`{" "}` does not survive prettier) —
// and with it the two plain authoring slips that have no legitimate use: a span
// butted against a word, and the separating space parked inside the emphasis.
// (was lib/__tests__/emphasis-spacing.test.ts)
const INLINE_SPAN = "/^(?:strong|em|b|code|a)$/";
const EMPHASIS_SPAN = "/^(?:strong|em|b)$/";
const BUTTED_SPAN_MESSAGE =
  "An emphasis span butted against the word beside it renders without the space (#1447) — put the space in the text node.";
const SPACE_INSIDE_MESSAGE =
  "The separating space belongs outside the emphasis element, not bolded inside it (#1447).";
const EMPHASIS_SPACING = [
  {
    selector: `:matches(JSXElement[openingElement.name.name=${INLINE_SPAN}], JSXExpressionContainer) + JSXText[raw=/^ [\\s\\S]*&(?:[a-zA-Z]+|#[0-9]+);/]`,
    message:
      "An HTML entity in a text node that follows a tag or expression and starts with a space loses that space in the server render (#1447) — write the character itself (’ “ ”).",
  },
  {
    selector: `JSXElement[openingElement.name.name=${INLINE_SPAN}] + JSXText[raw=/^[A-Za-z0-9]/]`,
    message: BUTTED_SPAN_MESSAGE,
  },
  {
    selector: `JSXText[raw=/[A-Za-z0-9]$/] + JSXElement[openingElement.name.name=${EMPHASIS_SPAN}]`,
    message: BUTTED_SPAN_MESSAGE,
  },
  {
    selector: `JSXElement[openingElement.name.name=${EMPHASIS_SPAN}] > JSXText:first-child[raw=/^ /]`,
    message: SPACE_INSIDE_MESSAGE,
  },
  {
    selector: `JSXElement[openingElement.name.name=${EMPHASIS_SPAN}] > JSXText:last-child[raw=/ $/]`,
    message: SPACE_INSIDE_MESSAGE,
  },
];

// #794 11a — free text renders through <NotesText>. Seventeen surfaces rendered a
// `.notes` value bare, so an imported multi-line note flattened to one run-on line
// and a pasted URL clipped in a min-w-0 cell. NotesText applies whitespace-pre-wrap
// and wrap-break-word, and takes the note as a PROP so the bare JSX child is the
// shape to ban; `notes={x.notes}` and `${x.notes}` are not renders.
// (was lib/__tests__/notes-text.test.ts)
const BARE_NOTES_BAN = [
  "MemberExpression[property.name='notes']",
  "LogicalExpression[operator=/^(?:\\?\\?|\\|\\|)$/] > MemberExpression.left[property.name='notes']",
].map((tail) => ({
  selector: `:matches(JSXElement, JSXFragment) > JSXExpressionContainer > ${tail}`,
  message:
    "Render free-text notes through <NotesText notes={…} /> (components/NotesText.tsx) so they wrap and keep their line breaks (#794).",
}));

// ── The JSX-attribute scanners (#5347 slice 3) ──────────────────────────────
//
// The same bar as slice 2: a guard moved here only when a shipped defect stands
// behind the shape it bans. The consolidation censuses, the icon-button pair and
// the guards a type already carries (typed routes) were deleted instead.

// #2535 — `aria-pressed` is a toggle-BUTTON state. An <a href> is role="link",
// which does not support it, so assistive technology announces NO selected state:
// four URL-state selectors shipped that way before SegmentedControl gained a link
// binding. A link that is the current view carries aria-current.
// (was lib/__tests__/link-aria-pressed-scan.test.ts)
const LINK_ARIA_PRESSED_BAN = {
  selector:
    "JSXOpeningElement[name.name=/^(?:a|Link)$/] > JSXAttribute[name.name='aria-pressed']",
  message:
    'aria-pressed is a toggle-button state and a link is role="link", so the selected state is announced to nobody (#2535) — use aria-current, or <SegmentedControl> with an href per option.',
};

// #3375/#3729 — information that exists only on hover does not exist on a phone:
// a `title=` renders nothing on touch and a non-interactive element cannot be
// focused. Explanatory text goes through a touch-reachable primitive
// (InfoTooltipIcon, ControlTooltip) and a control's name through aria-label plus
// an sr-only span. Intrinsic elements, plus the components that hand `title`
// straight to their anchor. (was lib/__tests__/raw-title-boundary.test.ts, which
// also resolved a renamed import; this keys on the tag name as written)
const RAW_TITLE_BAN = {
  selector:
    "JSXOpeningElement[name.name=/^(?:[a-z]|(?:Link|DestinationLink|DestinationActionLink|StandingDestinationLink|CardFootnote)$)/] > JSXAttribute[name.name='title']",
  message:
    "A title= attribute is hover-only, so its text does not exist on a phone (#3375) — explain through InfoTooltipIcon / ControlTooltip, and name a control with aria-label plus an sr-only span (#3729).",
};

// #3677 — 47 raw <details> each snapped open. components/Disclosure.tsx is the one
// that renders the element: it carries the continuity motion (#3676) and the
// marker suppression, and is exempted below. (was lib/__tests__/disclosure-owner-scan.test.ts)
const RAW_DETAILS_BAN = {
  selector: "JSXOpeningElement[name.name='details']",
  message:
    "A raw <details> snaps open — render <Disclosure> (components/Disclosure.tsx), which carries the continuity motion (#3677).",
};
const DISCLOSURE_OWNER = "components/Disclosure.tsx";

// #5181 — a command inside a role="menu" panel that carries no menu role is not
// counted or announced as an item of it: the episode kebab read as "menu, 1 item"
// over three. A panel is <OverflowMenu> (which hands role="menu" to its
// AnchoredPanel) or an element declaring the role itself; the population is the
// button / a / Link elements written among its CHILDREN in the same file — not its
// trigger prop, and not a wrapper component mounted there, which the render tier
// holds. NOTE the nesting: esquery honours `:has(> X)` one level at a time, so
// `:has(> A:has(> B))` is the spelling; `:has(> A > B)` matches nothing.
// (was lib/__tests__/menu-item-role-scan.test.ts)
const MENU_PANEL =
  ":matches(JSXElement[openingElement.name.name='OverflowMenu'], JSXElement:has(> JSXOpeningElement:has(> JSXAttribute[name.name='role']:has(> Literal[value='menu']))))";
const MENU_ITEM_ROLE_BAN = {
  selector: `${MENU_PANEL} > :not(JSXOpeningElement, JSXClosingElement) JSXOpeningElement[name.name=/^(?:button|a|Link)$/]:not(:has(> JSXAttribute[name.name='role']:has(> Literal[value=/^menuitem(?:checkbox|radio)?$/])))`,
  message:
    'A command inside a role="menu" panel announces itself as an item of it — add role="menuitem" (menuitemcheckbox / menuitemradio for a stateful one), or a screen reader does not count it (#5181).',
};

// #4924 — a recharts curve written as a literal. `type="monotone"` sat at nine
// call sites across six cards, so five weigh-ins drew the invented spline a
// ninety-point series gets; the curve is the scaffold's `chartCurve`. An axis'
// type="number" / "category" is a different prop of the same name and stays
// silent. (was the curve half of lib/__tests__/chart-scaffold-scan.test.ts; its
// dash, tooltip and recharts-importer registry halves had no catch and are gone)
const CHART_CURVES =
  "basis|basisClosed|basisOpen|bumpX|bumpY|cardinal|catmullRom|linear|linearClosed|monotone|monotoneX|monotoneY|natural|step|stepAfter|stepBefore";
const RAW_CURVE_BAN = {
  selector: `JSXAttribute[name.name='type'] > Literal[value=/^(?:${CHART_CURVES})$/]`,
  message:
    "A line's curve is chart vocabulary decided once — pass type={chartCurve} from components/chart-scaffold.tsx, not a literal (#4924).",
};

const UI_SYNTAX = [
  ...MUTED_TEXT_CONTRAST,
  BORDER_SLATE_BAN,
  NOTICE_BLOCK_BAN,
  UNWRAPPED_TABLE_BAN,
  ...EMPHASIS_SPACING,
  ...BARE_NOTES_BAN,
  LINK_ARIA_PRESSED_BAN,
  RAW_TITLE_BAN,
  RAW_DETAILS_BAN,
  MENU_ITEM_ROLE_BAN,
  RAW_CURVE_BAN,
];

// #544/#551 — a loose `flag !== "normal"` compare sorted the good "immune" titer
// to the top as if abnormal, and the same shape pushed it as a care-tier
// notification. Notability routes through isOutOfRange / isNonOptimal
// (lib/reference-range); the compare is banned in either order on any
// flag-named value. lib/reference-range/qualitative.ts MAPS parsed results onto
// flag values rather than deciding notability, and is exempted below.
// (was lib/__tests__/flag-notability.test.ts)
const FLAG_NORMAL_BAN = {
  selector:
    "BinaryExpression[operator=/^(?:===|!==|==|!=)$/]:matches([right.value='normal']:matches([left.name=/flag$/i], [left.property.name=/flag$/i]), [left.value='normal']:matches([right.name=/flag$/i], [right.property.name=/flag$/i]))",
  message:
    'Do not decide notability by comparing a flag to "normal" — a neutral flag such as "immune" is miscategorized (#544). Route through isOutOfRange / isNonOptimal from @/lib/reference-range.',
};
const FLAG_VALUE_MAPPER = "lib/reference-range/qualitative.ts";

// #454 — every outbound Telegram obligation (length and keyboard limits, the
// "[Name] " attribution prefix, escaping, delivery accounting) is owned by
// lib/notifications/telegram.ts, so it alone imports the three raw send/edit
// primitives. A callback handler that edited a message directly is how the prefix
// was dropped (#377), and a builder reaching the wire is how the 4096-char cap was
// missed (#379). scripts/reach-graph.ts names the same three as SENDERS for reach
// derivation — a different question, not a second copy of this ban.
// (was the import half of lib/__tests__/telegram-chokepoint.test.ts; the raw
// call() is module-private, so the module system carries that half)
const TELEGRAM_RAW_SEND_BAN = {
  group: ["**/telegram-api"],
  importNames: [
    "sendMessageRaw",
    "editMessageTextRaw",
    "editMessageReplyMarkupRaw",
  ],
  message:
    "Only lib/notifications/telegram.ts sends or edits on the wire — go through telegramChannel / sendTelegramMessage / rebuildMessage so limits, the [Name] prefix and delivery accounting apply (#454).",
};
const TELEGRAM_CHOKEPOINT = "lib/notifications/telegram.ts";

// #985 — every email leaves through lib/email.ts, the sole importer of nodemailer:
// that is where TLS is enforced, where "not configured" refuses rather than sends,
// and where the deterministic test capture lives. A second importer of the raw
// transport would send without those. A security boundary rather than a caught
// defect (owner ruling on #5347 slice 3), kept as the Telegram ban's twin.
// (was lib/__tests__/email-chokepoint.test.ts)
const EMAIL_RAW_SEND_BAN = {
  group: ["nodemailer", "nodemailer/*"],
  message:
    "Only lib/email.ts imports nodemailer — send through sendEmail there so TLS enforcement, the not-configured refusal and delivery capture apply (#985).",
};
const EMAIL_CHOKEPOINT = "lib/email.ts";

// #1891 — a sortable item translates, it does not scale. `CSS.Transform.toString()`
// carries rectSortingStrategy's scaleX/scaleY, which morphs the dragged item toward
// the slot it passes over — invisible on uniform tiles, an owner-reported squash and
// stretch on dashboard cards of differing heights. `CSS.Translate.toString()` is the
// translation alone, which is all a reorder needs. (was the ban half of
// lib/__tests__/sortable-transform-scan.test.ts; its other half pinned the list of
// useSortable consumers, which is a registry rather than a defect)
const SORTABLE_TRANSFORM_BAN = {
  object: "CSS",
  property: "Transform",
  message:
    "Position a sortable item with CSS.Translate.toString(transform) — CSS.Transform carries scaleX/scaleY and distorts an item whose neighbours differ in size (#1891).",
};

// A grandfathered file keeps every ban of its level but the one it owns.
const without = (level, ...bans) => level.filter((ban) => !bans.includes(ban));

// Accumulating levels, narrowest last — see the mechanic at the top of this section.
const SYNTAX_ALL = TEMPORAL_BRAND_CAST_SELECTORS.map((selector) => ({
  selector,
  message:
    "Do not cast or re-alias to a temporal brand. Obtain it from a minter that validates or constructs it (lib/temporal-types.ts, #2899).",
}));
// REVALIDATE_PATH_BAN's other spelling: the same prohibition as a dynamic import.
// Named so lib/revalidate.ts's block can drop the one ban it owns and keep the rest.
const REVALIDATE_DYNAMIC_IMPORT_BAN = {
  selector:
    "VariableDeclarator[id.type='ObjectPattern']:has(Property[key.name='revalidatePath']) ImportExpression[source.value='next/cache']",
  message:
    "Use revalidateRoute from lib/revalidate.ts so the target remains compile-checked (#1636/#2149).",
};
// Shared syntax restrictions remain active in every narrower block below.
const APP_SURFACE_SYNTAX = [
  {
    selector:
      "JSXOpeningElement[name.name='PageContainer'] > JSXAttribute[name.name='className'] :matches(Literal[value=/(^|[\\s:])max-w-[[\\w./-]/], TemplateElement[value.raw=/(^|[\\s:])max-w-[[\\w./-]/])",
    message:
      "Use PageContainer's width prop for its measure; className may supply spacing and centering, not max-w-* overrides.",
  },
  REVALIDATE_DYNAMIC_IMPORT_BAN,
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.name='page'][callee.property.name=/^(?:on|once)$/][arguments.0.value='dialog']",
    message:
      "Do not install a Playwright dialog handler: native browser dialogs are prohibited, and accepting one would hide a regression.",
  },
];
// The level `app/`, `components/`, `lib/`, `scripts/` and `e2e/` already sit on —
// named so the e2e blocks below can spread it rather than re-listing its members.
const SYNTAX_APP_SURFACE = [...SYNTAX_ALL, ...APP_SURFACE_SYNTAX];
// Production code is also where the #794/#1447/#1891 UI shapes and the #544 flag
// compare are banned; a test tier may quote any of them.
const SYNTAX_PRODUCTION = [
  ...SYNTAX_APP_SURFACE,
  RPE_BRAND_CAST,
  ...WRITE_BRAND_CAST,
  ...UI_SYNTAX,
  FLAG_NORMAL_BAN,
];
const SYNTAX_PRODUCTION_KEYED = [...SYNTAX_PRODUCTION, ...RPE_KEY_LITERAL];
const SYNTAX_LIB_APP = [
  ...SYNTAX_PRODUCTION_KEYED,
  ...OURA_SCORE_KINDS,
  ...FITBIT_SCORE_KINDS,
];
const IMPORT_PATHS_PRODUCTION = [REVALIDATE_PATH_BAN, RPE_MINTER_BAN];
const IMPORT_PATTERNS_PRODUCTION = [TYPESCRIPT_API_PATTERN];
// Shipped code only: a test tier stubs the raw Telegram primitives (the callback
// DB tests mock telegram-api's network hop), and the revalidate block above reads
// the test trees too, so the ban joins at the first level that ignores them.
const IMPORT_PATTERNS_SHIPPED = [
  ...IMPORT_PATTERNS_PRODUCTION,
  TELEGRAM_RAW_SEND_BAN,
  EMAIL_RAW_SEND_BAN,
];
const IMPORT_PATTERNS_LIB_APP = [...IMPORT_PATTERNS_SHIPPED, STREAK_MODULE_BAN];
const restrictImports = (paths, patterns) => ["error", { paths, patterns }];

// ── The test-tree scanners (#5350 siblings) ──────────────────────────────────
//
// Two more Vitest walkers, over the test tiers rather than the product trees, each
// with a shipped defect behind the shape it bans. The blocks at the end of the config
// re-state the level their files sit on (the mechanic above); the two owners keep
// every other ban of that level through a converse block.

// #3248 — a raw mkdtemp in a test file has no teardown a killed run can honour, and a
// prefix of its own is invisible to the stale-entry sweep: 19,221 stranded directories
// (24 GB) through twenty call sites written after #2529 fixed the first one. Every
// test temp directory comes from makeTmpDir, which sweeps by construction. Both
// spellings the tree used are matched: the property (`fs.mkdtempSync`,
// `fsMod.mkdtempSync`, `fs.promises.mkdtemp`) and the named import. scripts/ stays
// out, as it was under the scan: those run by hand, once, and clean up after
// themselves. (was lib/__tests__/tmp-dir-census.test.ts)
const RAW_MKDTEMP_MESSAGE =
  'Use makeTmpDir("<label>") from lib/__tests__/tmp-dir.ts — a raw mkdtemp is invisible to the stale-entry sweep, so an interrupted run strands the directory forever (#3248).';
const RAW_MKDTEMP_PROPERTY_BANS = ["mkdtempSync", "mkdtemp"].map(
  (property) => ({ property, message: RAW_MKDTEMP_MESSAGE })
);
const RAW_MKDTEMP_IMPORT_BAN = {
  group: ["fs", "node:fs", "fs/promises", "node:fs/promises"],
  importNames: ["mkdtempSync", "mkdtemp"],
  message: RAW_MKDTEMP_MESSAGE,
};
const IMPORT_PATTERNS_TEST_TREES = [
  ...IMPORT_PATTERNS_PRODUCTION,
  RAW_MKDTEMP_IMPORT_BAN,
];
const TMP_DIR_MAKER = "lib/__tests__/tmp-dir.ts";

// #3565 — a historical-shape fixture names the migration it stops before. Slicing the
// registry by POSITION (`MIGRATIONS.slice(0, -1)`, "every migration but the newest")
// is right on exactly the day X is newest; the next migration to land pushes X into
// the prefix and the "before" database silently receives the future while the test
// stays green — one fixture measured somebody else's migration for weeks that way.
// `migrationsBefore(name)` (lib/migrations/versions/index.ts) throws on an unknown
// name instead. `NUMBERED_MIGRATIONS.slice` is the closed numbered era's own remedy
// and `MIGRATIONS[0]` / `.find((m) => m.id === 41)` are identity, so only the two
// positional calls on the bare registry are matched. Two owners: the runner test,
// whose subject IS the registry's positional invariants, and the replay census, which
// visits every prefix in turn (#3590).
// (was lib/__tests__/migration-historical-fixture-scan.test.ts)
const MIGRATION_POSITIONAL_BAN = {
  selector:
    "CallExpression > MemberExpression.callee[object.name='MIGRATIONS'][property.name=/^(?:slice|findIndex)$/]",
  message:
    'Position is not identity: MIGRATIONS.slice / .findIndex means "before X" on exactly one day, then silently rebuilds the future into the "before" database and keeps passing (#3565) — use migrationsBefore("<migration name>") from @/lib/migrations/versions.',
};
const MIGRATION_RUNNER_TEST = "lib/__db_tests__/runner.test.ts";
const MIGRATION_REPLAY_CENSUS = "scripts/migration-replay-census.ts";

// The unit tiers and the blessed e2e interaction module sit on the app-surface level
// (the revalidate block); the action tier sits on SYNTAX_ALL alone; a JavaScript
// source under any of these roots sits on no syntax level at all.
const UNIT_TEST_TREES = [
  "lib/__tests__/**/*.{ts,tsx}",
  "lib/__db_tests__/**/*.{ts,tsx}",
  "components/__tests__/**/*.{ts,tsx}",
];
const ACTION_TEST_TREE = "lib/__action_tests__/**/*.{ts,tsx}";
const TEST_TREE_SCRIPTS = [
  "lib/__tests__/**/*.{js,jsx,mjs,cjs}",
  "lib/__db_tests__/**/*.{js,jsx,mjs,cjs}",
  "lib/__action_tests__/**/*.{js,jsx,mjs,cjs}",
  "components/__tests__/**/*.{js,jsx,mjs,cjs}",
  "e2e/**/*.{js,jsx,mjs,cjs}",
];

// ── e2e/**: the hygiene scan's zero-allowlist bans (#5350) ───────────────────
//
// Each ban below was a per-file COUNT frozen at zero with an EMPTY allowlist in
// lib/__tests__/e2e-hygiene.test.ts — a straight prohibition wearing a ratchet's
// clothes. Every one is a syntax shape with no type surface, so it moves onto the
// parse ESLint already runs, exactly as #5392 moved the nine production walkers.
//
// THE ESCAPE MARKERS MOVE WITH THEM. A scan line carrying `first-ok: <why>` (or
// `topass-ok`, `waitfortimeout-ok`, `clock-ok`, `ci-ok`, `confirm-delete-ok`) was
// dropped before counting; the same line now reads
// `// eslint-disable-line no-restricted-syntax -- first-ok: <why>`, which keeps the
// reason on the line it excuses and costs no extra line.
//
// AND THAT IS A REACH CHANGE, STATED RATHER THAN HIDDEN: the marker was per-PATTERN
// and a disable directive is per-RULE. A line excused for `.first()` is now also
// excused for every other `no-restricted-syntax` ban that could appear on it. The
// bans that most plausibly co-occur with a marked line are split onto
// `no-restricted-properties` and `no-restricted-imports` where the shape allows, so
// the collision surface is smaller than one rule holding all of them — but it is not
// zero. `reportUnusedDisableDirectives` is on (#5347), so a directive that stops
// excusing anything is reported instead of silently kept.
//
// ONE SCAN RULE DID NOT COME: the offline-navigation guard (#3002) asks whether a
// `.goto()` sits BETWEEN a `setOffline(true)` and a `setOffline(false)` with no
// `readyForOffline()` before it. That is a state machine over sibling statements,
// which esquery cannot express, so it stays in lib/__tests__/e2e-hygiene.test.ts.

// The blessed interaction module OWNS the settle patterns it exists to centralize
// (`followLink`'s internal waits, plus the decision-tree header that spells both
// out), so the scan never read it — SCAN_EXCLUDE, one entry. An `ignores` here
// leaves it on the level above, which is what that exclusion meant.
const E2E_HELPERS = "e2e/helpers.ts";
// The DB-per-worker harness IS the thing the harness rules point at: it imports
// `test` from Playwright to extend it, reads ALLOS_DB_PATH to hand out
// `workerDbPath()`, and takes the wall-clock reading `frozenNow()` is derived from.
const E2E_WORKER_HARNESS = [
  "e2e/fixtures.ts",
  "e2e/worker-env.ts",
  "e2e/global-setup.ts",
  "e2e/global-teardown.ts",
];
const E2E_FAMILY_HOME = "e2e/family-helpers.ts";
const E2E_FIXTURE_PROFILE = "e2e/fixture-profile.ts";

const HYGIENE_DOC = "see docs/internals/e2e-hygiene.md.";

const WALL_CLOCK_MESSAGE = `A spec's "now" is the harness's frozen now, never the wall clock (#1538) — use frozenNow() from ./worker-env, or carry a \`clock-ok: <why>\` disable line for a use that is NOT a stored timestamp (a unique-name suffix, a TOTP probe); ${HYGIENE_DOC}`;

// THE FOUR BANS THAT CARRY LIVE ESCAPE TRAFFIC sit on `no-restricted-properties`
// rather than on `no-restricted-syntax`, and that placement is the point: 748 of the
// 750 reviewed escapes in e2e/ today are one of these four, and a disable directive
// is per-RULE where the retired scan's same-line marker was per-PATTERN. Splitting
// them off means a line excused for `.first()` still cannot smuggle in a temporal
// brand cast, a wall-clock CONSTRUCTOR or any other no-restricted-syntax ban. The
// four remaining collisions are between these four themselves, which is what the
// scan's own per-file counts could not distinguish either.
const E2E_PROPERTY_BANS = [
  {
    // #868 (ii) — a fixed sleep asserts nothing and is either too short (flakes
    // under contention) or too long. The ONE sanctioned use is an irreducible
    // bounded absence-of-effect proof, which carries its reason on a disable line.
    property: "waitForTimeout",
    message: `waitForTimeout(...) asserts nothing — await the actual signal (settledClick / followLink / a retrying expect on one locator), or carry a \`waitfortimeout-ok: <why>\` disable line ONLY for an irreducible bounded absence-of-effect proof; ${HYGIENE_DOC}`,
  },
  {
    // #868 (iii) — on a shared seeded surface "the first row" is whatever a
    // neighbour spec or a retry left on top.
    property: "first",
    message: `.first() on a shared surface takes whatever a neighbour spec left on top — target a spec-owned fixture by exact locator, or carry a \`first-ok: <why>\` disable line for a reviewed owned-fixture use; ${HYGIENE_DOC}`,
  },
  {
    // #868 (iv) — a retrying block proves "passes within N attempts", not "works",
    // and hides WHICH step raced.
    property: "toPass",
    message: `.toPass( proves "passes within N attempts", not "works", and hides which step raced — await the actual signal, or carry a \`topass-ok: <why>\` disable line for a reviewed last resort; ${HYGIENE_DOC}`,
  },
  { object: "Date", property: "now", message: WALL_CLOCK_MESSAGE },
  // #3248 — the temp-dir ban reaches e2e/** as it did under its scan.
  ...RAW_MKDTEMP_PROPERTY_BANS,
];
// The harness reads the wall clock ONCE, to derive the frozen now every spec then
// asks for — so it is the one surface that drops `Date.now`, exactly as it drops the
// `new Date()` twin among the syntax bans.
const E2E_PROPERTY_BANS_WORKER_HARNESS = E2E_PROPERTY_BANS.filter(
  (ban) => ban.property !== "now"
);

// Applies to every e2e source but the blessed interaction module.
const E2E_SETTLE_BANS = [
  {
    // #868 (i) — a readiness gate that settles on a quiet page but not a streaming
    // one, and waits for the wrong thing: network silence, not "my interaction
    // landed".
    selector:
      "CallExpression[callee.property.name='waitForLoadState'][arguments.0.value='networkidle']",
    message: `waitForLoadState("networkidle") settles on network silence, not on your interaction landing — use settledClick / followLink from e2e/helpers.ts; ${HYGIENE_DOC}`,
  },
  {
    // A committed skip is missing coverage disguised as a test; a runtime skip makes
    // a green run ambiguous about which contract ran.
    selector:
      "CallExpression[callee.object.name='test'][callee.property.name='skip']",
    message: `A committed test.skip makes a green run ambiguous about which contracts ran — delete obsolete coverage, or make the boundary deterministic in the fixture; ${HYGIENE_DOC}`,
  },
  {
    // #2645/#2648 — the harness serves ONE build shape (every worker's `next start`
    // runs NODE_ENV=production), so the runner is not a proxy for "is this a
    // production build" and the non-CI arm of such a branch is unreachable.
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='CI']",
    message: `The harness serves ONE build shape — every worker runs NODE_ENV=production — so process.env.CI is not a proxy for "is this a production build" (#2645/#2648). Assert what the harness can serve, or name the runner-only fact on a \`ci-ok: <why>\` disable line; ${HYGIENE_DOC}`,
  },
  {
    // #2437/#2559 — two boundingBox()es inside one Promise.all are two CDP
    // round-trips with a layout pass between them, so a RELATIVE assertion built
    // from them can describe a layout that never existed. The sibling combinator
    // fires on the second and later box in the array, so a third element between
    // them (which the retired regex's lazy gap could walk past into the NEXT
    // Promise.all) is caught and cross-statement pairing is impossible.
    selector:
      "CallExpression[callee.object.name='Promise'][callee.property.name='all'] > ArrayExpression > CallExpression[callee.property.name='boundingBox'] ~ CallExpression[callee.property.name='boundingBox']",
    message: `Two boundingBox() reads through one Promise.all are not atomic — each is its own round-trip and the page lays out between them. Use settledBoxes([...]) from e2e/helpers.ts, which repeats the group until two consecutive reads agree; ${HYGIENE_DOC}`,
  },
  {
    // #2714 — a measured point is a fact about the PAST from the instant it is
    // returned, and a surface that relays out after settling moves the target out
    // from under the gesture, whereupon the recognizer rejects the landing and the
    // swipe does nothing at all. A document-anchored gesture names its coordinates
    // inline; that is the only honest spelling.
    selector:
      "CallExpression[callee.name='touchSwipe'][arguments.0.type='Identifier']:not([arguments.1.type='ObjectExpression'])",
    message: `A swipe's starting point may only be an inline { x, y } literal — a MEASURED point is stale from the instant it is returned (#2714). Use touchSwipeFrom(page, locator, { dx, dy }) from e2e/helpers.ts, which re-aims and proves where the finger landed; ${HYGIENE_DOC}`,
  },
  {
    // #3454 — the confirm dialog's Delete is a client toggle with no POST to settle
    // on, so a tap dispatched before React attaches is discarded in silence.
    selector:
      "CallExpression[callee.property.name='click']:has(CallExpression[callee.property.name='getByTestId'][arguments.0.value='confirm-dialog']):has(Property[key.name='name'][value.value='Delete'])",
    message: `A bare .click() on a confirm dialog's Delete can be swallowed before React attaches — use deleteActivityFromForm, or carry a \`confirm-delete-ok: <why>\` disable line; ${HYGIENE_DOC}`,
  },
  {
    // #1543 — the app shell clips horizontal overflow, so a document-width vs
    // viewport-width comparison is unconditionally true on every (app) page.
    selector:
      "MemberExpression[property.name='scrollWidth'][object.property.name='documentElement']",
    message: `The app shell clips horizontal overflow, so a document-level width comparison asserts nothing on an (app) page (#1543) — use expectNoClippedContent(page) from e2e/helpers.ts, which measures element-level containment; ${HYGIENE_DOC}`,
  },
  {
    selector:
      "MemberExpression[property.name='scrollWidth'][object.object.name='document'][object.property.name='body']",
    message: `The app shell clips horizontal overflow, so a document-level width comparison asserts nothing on an (app) page (#1543) — use expectNoClippedContent(page) from e2e/helpers.ts, which measures element-level containment; ${HYGIENE_DOC}`,
  },
  ...[
    // #4369 — a bare fixed year is a date fuse with no date attached: a relative
    // fixture eventually leaves it, and the negated form then passes vacuously.
    // The string arm is the whole literal (`"2024"`, not `"Jan 2024"`); the regex
    // arm matches a year anywhere in the pattern, which is what the retired scan's
    // `/…\b20\d{2}\b…/` alternative did.
    "CallExpression[callee.property.name='toContainText'][arguments.0.value=/^20[0-9]{2}$/]",
    "CallExpression[callee.property.name='toContainText'][arguments.0.regex.pattern=/20[0-9]{2}/]",
    "CallExpression[callee.property.name='toContainText'] > TemplateLiteral > TemplateElement[value.raw=/^20[0-9]{2}$/]",
  ].map((selector) => ({
    selector,
    message: `A bare fixed year is not a date contract: a relative fixture eventually leaves it and a negated assertion then passes vacuously (#4369). Assert the fixture-derived display date, or use a year-SHAPE regex when proving no date renders; ${HYGIENE_DOC}`,
  })),
];

// The Settings → Family create/grant controls are onClick Server-Action handlers,
// not form submits, so an inline goto→fill→click flakes on the hydration swallow /
// toaster false-settle (#830/#1111). Nine near-identical copies had accreted before
// e2e/family-helpers.ts became their one home — which is why that file is the one
// exemption: it OWNS these three markers by design.
const E2E_FAMILY_BANS = [
  [
    "CallExpression[callee.property.name='getByPlaceholder'][arguments.0.value='Username']",
    "createLoginViaFamily",
    "create-login",
  ],
  [
    ":matches(Literal[value='Add a profile'], TemplateElement[value.raw='Add a profile'])",
    "createProfileViaFamily",
    "create-profile",
  ],
  [
    ":matches(Literal[value='Save access'], TemplateElement[value.raw='Save access'])",
    "setGrantsViaFamily",
    "set-grants",
  ],
].map(([selector, helper, what]) => ({
  selector,
  message: `An inline Settings → Family ${what} sequence flakes on the onClick+refresh hydration swallow / toaster false-settle (#830/#1111) — use ${helper} from e2e/family-helpers.ts; ${HYGIENE_DOC}`,
}));

// #1487 — a fixture profile built with a bare INSERT starts with no `saved_items`
// rows, so it renders an empty Trends Overview no real profile can be in; a bare
// DELETE leaves the rows the constructor seeded and fails on their foreign key.
// e2e/fixture-profile.ts is the constructor pair's home and is the one exemption.
const E2E_PROFILE_SQL_BANS = [
  [
    String.raw`INSERT\s+(?:OR\s+\w+\s+)?INTO\s+profiles\b`,
    "A raw INSERT INTO profiles skips the standard Overview metric seeds every production-created profile gets (#1487) — use createFixtureProfile from e2e/fixture-profile.ts",
  ],
  [
    String.raw`DELETE\s+FROM\s+profiles\b`,
    "A raw DELETE FROM profiles leaves the rows the fixture CONSTRUCTOR seeded and fails on their foreign key (#1487) — use destroyFixtureProfile from e2e/fixture-profile.ts, the constructor's pair",
  ],
].map(([pattern, message]) => ({
  selector: `:matches(Literal[value=/${pattern}/i], TemplateElement[value.raw=/${pattern}/i])`,
  message: `${message}; ${HYGIENE_DOC}`,
}));

// #1538 — the DB-per-worker harness. A spec importing `test` from "@playwright/test"
// opts out of it entirely (no per-worker baseURL, no per-worker session), and
// ALLOS_DB_PATH is the APP SERVER's environment, not the spec process's, so reading
// it opens the wrong worker's database. TYPE imports (Page, Locator, Browser) are
// not restricted — only the `test` binding is.
const E2E_HARNESS_IMPORT_BAN = {
  name: "@playwright/test",
  importNames: ["test"],
  message: `Importing \`test\` from "@playwright/test" opts out of the DB-per-worker harness (#1538) — import { test, expect } from "./fixtures"; type imports may stay; ${HYGIENE_DOC}`,
};
const E2E_HARNESS_BANS = [
  {
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.name='ALLOS_DB_PATH']",
    message: `ALLOS_DB_PATH is the APP SERVER's environment, not the spec process's — reading it opens the wrong worker's database (#1538). Use workerDbPath() from ./worker-env; ${HYGIENE_DOC}`,
  },
  {
    // #1538 — the app serves a frozen `now()` and a long lane drifts ~90 minutes
    // from real time, so a wall-clock timestamp lands in the app's future. The
    // `Date.now()` half of this ban is a PROPERTY and sits with the other three
    // high-traffic escapes below; only the constructor form needs a selector.
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: WALL_CLOCK_MESSAGE,
  },
];

// #3946 — `deleteActivitiesTitled` in e2e/shared-profile-guard.ts is the one
// definition, and it existed verbatim in three specs before that.
//
// THE PATTERN COMES FROM HOW THE SPECS SPELL IT, not from how the issue described
// it: a census found five spellings, so a rule written for `WHERE title = ?` alone
// would have shipped green and blind to four of them. It stops short of
// `profile_id = ?` on purpose — a selector cannot resolve a constant, and that
// binding may be a spec-OWNED fixture profile, which the shared helper must never
// touch. `LIKE` is out of scope too: a prefix sweep is a different contract.
//
// SPECS ONLY. A seed and a fixture module delete-then-insert to stay idempotent
// over an existing database, which is their job and not a spec's cleanup.
const E2E_SHARED_ACTIVITY_DELETE = (() => {
  const pattern = String.raw`DELETE\s+FROM\s+activities\s+WHERE\s+(?:profile_id\s*=\s*1\s+AND\s+)?title\s*(?:=|IN\s*\()`;
  return {
    selector: `:matches(Literal[value=/${pattern}/i], TemplateElement[value.raw=/${pattern}/i])`,
    message: `An inline shared-profile activity cleanup is spelled once — use deleteActivitiesTitled from e2e/shared-profile-guard.ts (#3946); ${HYGIENE_DOC}`,
  };
})();

// FOUR FILES EACH OWN ONE GROUP, and each keeps every OTHER group — which is why
// these are composed sets and not an accumulating ladder. An `ignores` entry drops a
// file to the level ABOVE, so a ladder would have handed family-helpers.ts an
// exemption from the profile-SQL and harness bans it never had under the scan. The
// shape here is the one the two vendor allowlists above already use: state each
// surface's list, and the converse.
//
// e2e/ already sits on APP_SURFACE_SYNTAX (the revalidate block lists it), so that
// is what these build on rather than SYNTAX_ALL.
const SYNTAX_E2E_BASE = [
  ...SYNTAX_APP_SURFACE,
  ...E2E_SETTLE_BANS,
  MIGRATION_POSITIONAL_BAN,
];
const SYNTAX_E2E_ALL = [
  ...SYNTAX_E2E_BASE,
  ...E2E_FAMILY_BANS,
  ...E2E_PROFILE_SQL_BANS,
  ...E2E_HARNESS_BANS,
];
const SYNTAX_E2E_SPEC = [...SYNTAX_E2E_ALL, E2E_SHARED_ACTIVITY_DELETE];
// …and the three converses, each dropping exactly the group its file owns.
const SYNTAX_E2E_FAMILY_HOME = [
  ...SYNTAX_E2E_BASE,
  ...E2E_PROFILE_SQL_BANS,
  ...E2E_HARNESS_BANS,
];
const SYNTAX_E2E_FIXTURE_PROFILE = [
  ...SYNTAX_E2E_BASE,
  ...E2E_FAMILY_BANS,
  ...E2E_HARNESS_BANS,
];
const SYNTAX_E2E_WORKER_HARNESS = [
  ...SYNTAX_E2E_BASE,
  ...E2E_FAMILY_BANS,
  ...E2E_PROFILE_SQL_BANS,
];
// ── #5338 — THE CLOCK SEAM ───────────────────────────────────────────────────
//
// `Date.parse` on a zoneless date-TIME string answers in the SERVER's zone, by
// specification and silently: a date-only string is UTC, a stamp ending in `Z` is
// UTC, and only the middle case moves with the host. Production writers emit a `Z`
// and CI runs UTC, which is how a wrong write took four falsifying passes to surface.
// The replacement is a TYPE rather than a convention: `parseInstant` takes
// `CanonicalInstant | BareInstant` and `parseDay` takes `LocalDay` (lib/date.ts), so
// a caller holding a bare `string` cannot reach either and has to say which shape it
// has. A column no brand describes yet (`metric_samples.started_at`/`ended_at`, a
// settings value) keeps `parseUtcSql` — UTC either way, and not the banned call —
// with a same-line comment naming the shape it expects.
const DATE_PARSE_BAN = {
  object: "Date",
  property: "parse",
  message:
    "Date.parse answers in the SERVER's zone for a zoneless date-time string. Parse through parseInstant / parseDay (lib/date.ts), whose parameter type says the value is UTC; a value no brand describes yet goes through parseUtcSql with a same-line comment naming the shape expected (#5338).",
};
// The population that pre-dates the ban, exempt BY FILE the way the vendor-score
// surfaces are. The ruling migrates it ON TOUCH: converting a site in one of these
// files means converting every site in it and deleting the line here, so the list
// only shrinks. Every entry was a literal-`Z` or bare-variable `Date.parse` when the
// ban landed; none is an endorsement.
const DATE_PARSE_ON_TOUCH = [
  "app/(auth)/login/actions.ts",
  "components/illness/FeverChart.tsx",
  "lib/adherence-patterns.ts",
  "lib/ai-usage-rollup.ts",
  "lib/backup-verify.ts",
  "lib/calorie-estimate.ts",
  "lib/chart-time-axis.ts",
  "lib/clinical-parse.ts",
  "lib/coaching/common.ts",
  "lib/coaching/engine.ts",
  "lib/derived-biomarkers.ts",
  "lib/endurance-plan.ts",
  "lib/food-drug-ledger.ts",
  "lib/goal-pacing.ts",
  "lib/integrations/backfill-progress.ts",
  "lib/integrations/health-connect.ts",
  "lib/local-day-window.ts",
  "lib/metric-snapshot.ts",
  "lib/metric-sources.ts",
  "lib/metric-window-overlap.ts",
  "lib/mobility-coverage.ts",
  "lib/niggle-model.ts",
  "lib/offline/writes.ts",
  "lib/optical-prescription.ts",
  "lib/photo/metadata-backfill.ts",
  "lib/practice-log.ts",
  "lib/queries/continuous-streams.ts",
  "lib/queries/correction-history.ts",
  "lib/queries/intake/refill.ts",
  "lib/queries/steps-target.ts",
  "lib/recommendation-run.ts",
  "lib/reference-range/retest.ts",
  "lib/sleep-retime-db.ts",
  "lib/training-observations.ts",
  "lib/travel-timezone.ts",
  "lib/trend-annotations.ts",
  "lib/weight-anomaly.ts",
  "lib/workout-recommendation.ts",
  "scripts/seed.ts",
];
// #1878 — was inline in its block below; named so the clock-seam block after it can
// re-state it for app/ and components/ (the flat-config mechanic above).
const ROUTER_REFRESH_BAN = {
  object: "router",
  property: "refresh",
  message:
    "Decide which this is: CHROME (a background actor — repaint through useChromeRefresh so a half-typed form is not emptied) or USER (the person asked for it — keep the direct call and say why on an eslint-disable line) (#1878).",
};
// #2888 — named so the converse block for the training tone sibling can restate it.
const TRAINING_SCOPE_KIND_BAN = {
  selector:
    "BinaryExpression[operator=/^[!=]==?$/][right.type='Literal']:matches([left.name='scope_kind'], [left.property.name='scope_kind'])",
  message:
    'Filter with getFrequencyTargetProgressForHome(profileId, "training") — a private scope_kind list is the subtraction #2888 removed.',
};
const SYNTAX_TRAINING = [...SYNTAX_LIB_APP, TRAINING_SCOPE_KIND_BAN];

const config = [
  // Global ignores: other checkouts, build output, dependencies, and runtime data.
  {
    ignores: [
      ".claude/worktrees/",
      ".next/",
      ".next-demo/",
      "node_modules/",
      "data/",
      "coverage/",
      "out/",
      "build/",
      "dist/",
      "e2e/.data/",
      "e2e/.auth/",
      "test-results/",
      "playwright-report/",
      "blob-report/",
      "playwright/.cache/",
    ],
  },
  // A disable comment whose ban has gone quiet is reported as an error instead of
  // silently kept (#5347). Delete the directive; do not leave it as documentation.
  {
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },
  ...nextCoreWebVitals,
  // The compiler API comes from `typescript-api`, a devDependency aliased to
  // `npm:typescript@5.9`, and never from `typescript` itself (#3559). TS 7 turns the
  // root export into a version stub and moves `createSourceFile` / `forEachChild` to
  // entries it marks UNSTABLE, so a plain `import ts from "typescript"` stops
  // resolving to a compiler at all — which would take the Server Action
  // authorization sweep and the adult-only write scan red on a version bump. Sixteen
  // files import the alias today; this is what stops a seventeenth reopening it.
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [TYPESCRIPT_API_PATTERN],
        },
      ],
    },
  },
  // The temporal brands (#2899, lib/temporal-types.ts) are worth exactly as much as
  // the weakest way to obtain one. A brand comes from a minter that validated or
  // constructed it; the constructing minters carry their one permitted cast on a
  // `// eslint-disable-next-line no-restricted-syntax -- <brand> minter:` line.
  //
  // This rule is a RATCHET over spellings, not a proof: it refuses the ways of naming
  // a brand as a cast target, an alias or a renamed import/export that
  // lib/__tests__/temporal-types.test.ts lists, and that list is the definition of
  // what it catches. TypeScript's type grammar has more ways to name a type than any
  // selector list — three falsifying passes each found new ones — so a spelling the
  // test does not list is an ADDITION (add the selector and the test row), never a
  // refutation, and the reviewer's job is unchanged by the rule's existence. A DB row
  // shape (`.get(...) as { date: LocalDay }`, or an alias/interface holding one) is
  // deliberately allowed — an object type literal is exempt — because a row may
  // carry the brand lib/time-columns.ts declares for that column.
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_ALL],
    },
  },
  // Production code revalidates through lib/revalidate.ts, whose generated-route
  // parameter makes stale paths a compile error (#1636/#2149). This restriction
  // used to be a Vitest source scanner that reread every file after ESLint had
  // already parsed it. Put the import boundary on that existing parse instead.
  // Action tests mock next/cache directly to observe the wrapper and are not app
  // callers; lib/revalidate.ts is the one module allowed to expose the raw API.
  {
    files: [
      "app/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
      "lib/**/*.{ts,tsx}",
      "scripts/**/*.{ts,tsx}",
      "e2e/**/*.{ts,tsx}",
    ],
    ignores: [REVALIDATE_MODULE, "lib/__action_tests__/**"],
    rules: {
      "no-restricted-imports": restrictImports(
        [REVALIDATE_PATH_BAN],
        IMPORT_PATTERNS_PRODUCTION
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_APP_SURFACE],
    },
  },
  // Native alert/confirm/prompt calls bypass the app's accessible dialog primitives.
  // This used to be a three-test Vitest scanner that reparsed every app/component
  // file with the TypeScript compiler API under coverage. ESLint already owns the AST
  // pass, and its core rule resolves scope, so the app's shadowed async `confirm()`
  // service remains valid while `window.confirm()` and an unshadowed bare call fail.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: {
      "no-alert": "error",
    },
  },
  // eslint-config-next 16 bundles eslint-plugin-react-hooks v6, whose
  // next/core-web-vitals preset newly enables the "React Compiler" rule family.
  // Every compiler rule family has completed its product-reviewed burn-down and
  // stays enforced alongside exhaustive-deps and the rest of the prior surface.
  // ── The retired scanners' rules, narrowest LAST ──────────────────────────────
  // Each block re-states the level it sits inside; a file listed in `ignores` falls
  // back to that level rather than to nothing. See the mechanic above the constants.
  //
  // Production, everywhere: the RPE opt-in seam (#3335). lib/rpe-tracking.ts carries
  // the one permitted import of the minter and the one spelling of the stored key on
  // its own disable line, and lib/rpe.ts the one permitted cast — the same shape the
  // temporal-brand minters use.
  {
    files: PRODUCTION_TREES,
    ignores: [...TEST_TREES, REVALIDATE_MODULE],
    rules: {
      "no-restricted-imports": restrictImports(
        IMPORT_PATHS_PRODUCTION,
        IMPORT_PATTERNS_SHIPPED
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_PRODUCTION],
    },
  },
  // The opt-in KEY, everywhere except migrations. A shipped migration is frozen text
  // (its sha256 is in lib/migrations/manifest.json), so the one that back-fills the
  // column keeps its own spelling of the key and cannot carry a disable comment.
  {
    files: PRODUCTION_TREES,
    ignores: [...TEST_TREES, REVALIDATE_MODULE, "lib/migrations/**"],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_PRODUCTION_KEYED],
    },
  },
  // lib/ + app/, outside both vendor allowlists: the streak scope (#1935…#1966) and
  // the vendor daily scores (#1069).
  {
    files: [
      "lib/**/*.{ts,tsx}",
      "app/**/*.{ts,tsx}",
      "components/**/*.{ts,tsx}",
    ],
    ignores: [
      ...TEST_TREES,
      REVALIDATE_MODULE,
      "lib/migrations/**",
      ...OURA_SURFACES,
      ...FITBIT_SURFACES,
    ],
    rules: {
      "no-restricted-imports": restrictImports(
        IMPORT_PATHS_PRODUCTION,
        IMPORT_PATTERNS_LIB_APP
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_LIB_APP],
    },
  },
  // An Oura display/ingest surface may name an Oura kind — and still not a Fitbit one.
  {
    files: OURA_SURFACES,
    ignores: FITBIT_SURFACES,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_PRODUCTION_KEYED,
        ...FITBIT_SCORE_KINDS,
      ],
    },
  },
  // …and the converse.
  {
    files: FITBIT_SURFACES,
    ignores: OURA_SURFACES,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_PRODUCTION_KEYED,
        ...OURA_SCORE_KINDS,
      ],
    },
  },
  // #3520 — the migration registry reaches this helper at DB startup, so it stays on
  // the leaf metric policy and off the full Health Connect parser and its application
  // graph. (was lib/__tests__/db-import-boundary.test.ts)
  {
    files: ["lib/metric-window-overlap.ts"],
    rules: {
      "no-restricted-imports": restrictImports(IMPORT_PATHS_PRODUCTION, [
        ...IMPORT_PATTERNS_LIB_APP,
        {
          group: ["**/integrations/health-connect"],
          message:
            "lib/db.ts loads the migration registry, which reaches this helper — import the shared constants from ./integrations/health-connect-metrics, not the full parser (#3520).",
        },
      ]),
    },
  },
  // …and the leaf it depends on stays dependency-free, which is what makes it a leaf.
  {
    files: ["lib/integrations/health-connect-metrics.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_PRODUCTION_KEYED,
        ...[
          "ImportDeclaration",
          "ImportExpression",
          "TSImportEqualsDeclaration",
          "CallExpression[callee.name='require']",
        ].map((selector) => ({
          selector,
          message:
            "The shared Health Connect metric policy is imported at DB startup and stays dependency-free — keep it a leaf module (#3520).",
        })),
      ],
    },
  },
  // #482/#840 — mobility coverage answers "mobilized?", strength coverage answers
  // "trained?". Merging them gives a false all-clear, so this module reads mobility
  // move slugs and never the lift catalog's coverage engine or strength set rows.
  // (was the scan half of lib/__tests__/mobility-coverage-apart.test.ts)
  {
    files: ["lib/mobility-coverage.ts"],
    rules: {
      "no-restricted-imports": restrictImports(IMPORT_PATHS_PRODUCTION, [
        ...IMPORT_PATTERNS_LIB_APP,
        {
          group: ["**/muscle-coverage"],
          message:
            'Mobility coverage must not be sourced from the strength coverage engine — it would answer "trained?" instead of "mobilized?" (#482).',
        },
      ]),
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_LIB_APP,
        {
          selector:
            ":matches(ImportSpecifier[imported.name='liftInfo'], Identifier[name='coverageFromSets'])",
          message:
            "Mobility coverage must not be sourced from the lift catalog or the strength coverage engine (#482).",
        },
        {
          selector:
            ":matches(Literal[value=/exercise_sets/], TemplateElement[value.raw=/exercise_sets/])",
          message:
            "Mobility coverage is counted from mobility sessions, never from strength set rows (#482).",
        },
      ],
    },
  },
  // #1049 — no domain surface imports the disclaimer copy. /disclaimer is the page the
  // copy is consolidated onto, so it is the one importer, exactly as lib/revalidate.ts
  // is the one module allowed to expose the raw revalidate API.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: [
      ...TEST_TREES,
      ...OURA_SURFACES.filter((f) => f.startsWith("app/")),
      "app/(app)/disclaimer/page.tsx",
    ],
    rules: {
      "no-restricted-imports": restrictImports(
        [...IMPORT_PATHS_PRODUCTION, DISCLAIMERS_BAN],
        IMPORT_PATTERNS_LIB_APP
      ),
    },
  },
  // #1878 — every `router.refresh()` is classified. A background actor repaints
  // through `useChromeRefresh` so the dirty-form registry can hold it; a repaint the
  // person asked for calls the router directly and carries its reason on a file-level
  // disable, which is the granularity the retired allowlist had (it listed FILES).
  // (was the first test of lib/__tests__/chrome-refresh-scan.test.ts)
  // #1891's sortable transform ban rides beside it: the same trees, the same rule.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: TEST_TREES,
    rules: {
      "no-restricted-properties": [
        "error",
        ROUTER_REFRESH_BAN,
        SORTABLE_TRANSFORM_BAN,
      ],
    },
  },
  // #5338 — the clock seam, over every production tree except the on-touch
  // population. lib/date.ts needs no exemption: the seam is built on `parseUtcSql`,
  // which appends the `Z` itself. app/ and components/ re-state #1878 and #1891
  // beside it so the narrower block above does not switch those bans off for them;
  // an on-touch file there falls back to that block and keeps #1878 and #1891 alone.
  {
    files: PRODUCTION_TREES,
    ignores: [...TEST_TREES, ...DATE_PARSE_ON_TOUCH],
    rules: {
      "no-restricted-properties": ["error", DATE_PARSE_BAN],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: [...TEST_TREES, ...DATE_PARSE_ON_TOUCH],
    rules: {
      "no-restricted-properties": [
        "error",
        DATE_PARSE_BAN,
        ROUTER_REFRESH_BAN,
        SORTABLE_TRANSFORM_BAN,
      ],
    },
  },
  // #2888 — the training surfaces reach the registry. `scope_kind !== "practice"` was a
  // private membership rule that disagreed with the two surfaces beside it, and a
  // subtraction only excludes what its author remembered; filter with
  // getFrequencyTargetProgressForHome so membership stays declared once in
  // CADENCE_SCOPES.home. (was the literal half of lib/__tests__/cadence-home.test.ts)
  {
    files: ["app/(app)/training/**/*.{ts,tsx}"],
    ignores: TEST_TREES,
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_TRAINING],
    },
  },
  // ── The grandfathered files of the #794 class bans (#5347 slice 2) ──────────
  // Each drops exactly the ban its file owns and keeps every other ban of the level
  // it sits on — the shape the two vendor allowlists above use.
  {
    files: NOTICE_TONE_MAPS,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...without(SYNTAX_LIB_APP, BORDER_SLATE_BAN, NOTICE_BLOCK_BAN),
      ],
    },
  },
  {
    files: SLATE_TONE_SIBLINGS,
    rules: {
      "no-restricted-syntax": [
        "error",
        ...without(SYNTAX_LIB_APP, BORDER_SLATE_BAN),
      ],
    },
  },
  {
    files: [SLATE_TONE_SIBLING_TRAINING],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...without(SYNTAX_TRAINING, BORDER_SLATE_BAN),
      ],
    },
  },
  {
    files: [TABLE_PRIMITIVE],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...without(SYNTAX_LIB_APP, UNWRAPPED_TABLE_BAN),
      ],
    },
  },
  // ── The owners of the #5347 slice 3 bans ────────────────────────────────────
  // The disclosure renders the <details>, the qualitative classifier maps onto the
  // flag values, and the two chokepoints import their raw transports; each keeps
  // every other ban of its level.
  {
    files: [DISCLOSURE_OWNER],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...without(SYNTAX_LIB_APP, RAW_DETAILS_BAN),
      ],
    },
  },
  {
    files: [FLAG_VALUE_MAPPER],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...without(SYNTAX_LIB_APP, FLAG_NORMAL_BAN),
      ],
    },
  },
  {
    files: [TELEGRAM_CHOKEPOINT],
    rules: {
      "no-restricted-imports": restrictImports(
        IMPORT_PATHS_PRODUCTION,
        without(IMPORT_PATTERNS_LIB_APP, TELEGRAM_RAW_SEND_BAN)
      ),
    },
  },
  {
    files: [EMAIL_CHOKEPOINT],
    rules: {
      "no-restricted-imports": restrictImports(
        IMPORT_PATHS_PRODUCTION,
        without(IMPORT_PATTERNS_LIB_APP, EMAIL_RAW_SEND_BAN)
      ),
    },
  },
  // ── The owner of the #5348 write-brand cast ban ─────────────────────────────
  // lib/auth.ts is where the three write gates turn a checked profile id into a
  // WriteAuthorizedProfileId, so it alone may cast to one; every other ban of its
  // level stays on. A block rather than a disable comment because the mint is one
  // expression inside an otherwise ordinary module.
  {
    files: [WRITE_BRAND_MINTER],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...without(SYNTAX_LIB_APP, ...WRITE_BRAND_CAST),
      ],
    },
  },
  // ── lib/revalidate.ts owns an IMPORT exemption, not a syntax one (#5856) ────
  // Its `ignores` entries above exempt it from REVALIDATE_PATH_BAN, and took every
  // `no-restricted-syntax` ban of its level with them — so a shipped module sat
  // outside the write-brand cast ban (#5348) and the RPE cast ban (#3335) while
  // every sampled row of eslint-config-composition.test.ts stayed green. This block
  // restores the level and leaves `no-restricted-imports` unset, which is the whole
  // and only exemption the module was granted.
  {
    files: [REVALIDATE_MODULE],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...without(SYNTAX_LIB_APP, REVALIDATE_DYNAMIC_IMPORT_BAN),
      ],
    },
  },
  // ── lib/notifications: no runtime import cycle (#2961 AC 3) ─────────────────
  // A module in a cycle evaluates against a partially initialised partner, and a
  // module-scope `const` read in that window is `undefined` — here a callback prefix
  // or a byte budget. The shipped case: callback-data.ts imported INTAKE_SEND_SLOTS
  // from intake-format.ts, which imported callbackDataFits back, and #5169 recorded
  // the edge gone while it was still there. `import type` is erased before anything
  // runs, so the rule skips type-only edges, as the scan did; the scan read
  // `import … from "./x"` and nothing else, so a value re-export
  // (`export { x } from "./y"`) closed a cycle it could not see (#5390) — the
  // plugin's graph carries re-exports. A dynamic `import()` is not counted either:
  // it runs after both modules have finished evaluating, which is why
  // post-workout-queue.ts reaches workout-presence.ts that way.
  // (was lib/__tests__/notification-import-cycles.test.ts)
  //
  // The one cycle this block used to name rather than hide is GONE (#5719).
  // post-workout-marker.ts → ../settings → (export *) settings/notifications →
  // queries/sleep → derived-situations → cycle-store → undo-delete-db →
  // merge-activity → post-workout-marker.ts, closed by 141207621 (#2597), was broken
  // at its last hop: writeActivityFold now takes the announcement carry as a required
  // parameter instead of importing it, so the write path holds no edge into
  // lib/notifications and every file in this directory is covered with no exemption.
  {
    files: ["lib/notifications/**/*.{ts,tsx}"],
    rules: {
      "import/no-cycle": [
        "error",
        {
          maxDepth: Infinity,
          ignoreExternal: true,
          allowUnsafeDynamicCyclicDependency: true,
        },
      ],
    },
  },
  // ── e2e/**: the retired hygiene scan's zero-allowlist bans (#5350) ──────────
  // The scan read `e2e/**/*.ts` — specs AND the driver/helper modules, because a
  // settle anti-pattern can hide in a helper the specs import (#868 phase 2). Only
  // e2e/helpers.ts was never read: it OWNS the settle patterns it exists to
  // centralize, so an `ignores` here leaves it on the level above, which is what
  // that one exclusion meant.
  {
    files: ["e2e/**/*.ts"],
    ignores: [E2E_HELPERS],
    rules: {
      "no-restricted-imports": restrictImports(
        [REVALIDATE_PATH_BAN, E2E_HARNESS_IMPORT_BAN],
        IMPORT_PATTERNS_TEST_TREES
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_ALL],
      "no-restricted-properties": ["error", ...E2E_PROPERTY_BANS],
    },
  },
  // The Settings → Family driver owns the three inline markers by design…
  {
    files: [E2E_FAMILY_HOME],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_FAMILY_HOME],
    },
  },
  // …the fixture-profile constructor pair owns the two profile writes…
  {
    files: [E2E_FIXTURE_PROFILE],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_FIXTURE_PROFILE],
    },
  },
  // …and the DB-per-worker harness IS what the harness bans point at: it extends
  // Playwright's `test`, reads ALLOS_DB_PATH to hand out workerDbPath(), and takes
  // the one wall-clock reading frozenNow() is derived from.
  {
    files: E2E_WORKER_HARNESS,
    rules: {
      "no-restricted-imports": restrictImports(
        [REVALIDATE_PATH_BAN],
        IMPORT_PATTERNS_TEST_TREES
      ),
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_WORKER_HARNESS],
      "no-restricted-properties": [
        "error",
        ...E2E_PROPERTY_BANS_WORKER_HARNESS,
      ],
    },
  },
  // A seed and a fixture module delete-then-insert to stay idempotent over an
  // existing database, which is their job and not a spec's cleanup — so the shared
  // activity cleanup is the one ban scoped to specs alone. None of the three files
  // above is a spec, so this block adds to the full list rather than to a converse.
  {
    files: ["e2e/**/*.spec.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...SYNTAX_E2E_SPEC],
    },
  },
  // ── The test-tree scanners' rules (#5350 siblings) ──────────────────────────
  // The unit tiers plus e2e/helpers.ts: the app-surface level with both bans. The
  // temp-dir maker and the migration runner test each own one ban and keep the other
  // through the two converse blocks after it.
  {
    files: [...UNIT_TEST_TREES, E2E_HELPERS],
    ignores: [TMP_DIR_MAKER, MIGRATION_RUNNER_TEST],
    rules: {
      "no-restricted-imports": restrictImports(
        [REVALIDATE_PATH_BAN],
        IMPORT_PATTERNS_TEST_TREES
      ),
      "no-restricted-properties": ["error", ...RAW_MKDTEMP_PROPERTY_BANS],
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_APP_SURFACE,
        MIGRATION_POSITIONAL_BAN,
      ],
    },
  },
  {
    files: [TMP_DIR_MAKER],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_APP_SURFACE,
        MIGRATION_POSITIONAL_BAN,
      ],
    },
  },
  {
    files: [MIGRATION_RUNNER_TEST],
    rules: {
      "no-restricted-imports": restrictImports(
        [REVALIDATE_PATH_BAN],
        IMPORT_PATTERNS_TEST_TREES
      ),
      "no-restricted-properties": ["error", ...RAW_MKDTEMP_PROPERTY_BANS],
    },
  },
  // The action tier mocks next/cache and sits outside the revalidate block.
  {
    files: [ACTION_TEST_TREE],
    rules: {
      "no-restricted-imports": restrictImports([], IMPORT_PATTERNS_TEST_TREES),
      "no-restricted-properties": ["error", ...RAW_MKDTEMP_PROPERTY_BANS],
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_ALL,
        MIGRATION_POSITIONAL_BAN,
      ],
    },
  },
  // scripts/ slices the registry only in the replay census; its temp directories
  // were never the scan's business.
  {
    files: ["scripts/**/*.{ts,tsx}"],
    ignores: [...TEST_TREES, MIGRATION_REPLAY_CENSUS],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SYNTAX_PRODUCTION_KEYED,
        MIGRATION_POSITIONAL_BAN,
      ],
    },
  },
  {
    files: ["scripts/**/*.{js,jsx,mjs,cjs}"],
    rules: {
      "no-restricted-syntax": ["error", MIGRATION_POSITIONAL_BAN],
    },
  },
  // A JavaScript source under the test roots (the two e2e build helpers today).
  {
    files: TEST_TREE_SCRIPTS,
    rules: {
      "no-restricted-imports": restrictImports([], IMPORT_PATTERNS_TEST_TREES),
      "no-restricted-properties": ["error", ...RAW_MKDTEMP_PROPERTY_BANS],
      "no-restricted-syntax": ["error", MIGRATION_POSITIONAL_BAN],
    },
  },
];

export default config;
