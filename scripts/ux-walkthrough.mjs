// UX walkthrough harness — a SEEING tool, not a test tier.
//
// Drives the real app through the first-run journeys (fresh-install onboarding,
// invite-another-user) in headless Chromium and saves a screenshot at every step,
// so a human (or agent) can review the actual experience end-to-end. It asserts
// nothing and is deliberately not part of any CI tier: journey *assertions* belong
// in e2e/onboarding.spec.ts and e2e/email-auth.spec.ts under the hygiene rules;
// this script trades that rigor for a linear, screenshot-per-step narrative
// against a from-scratch install (which the seeded e2e fixture never shows).
//
// Setup (run against a scratch DB, NEVER a real data/allos.db):
//
//   ALLOS_DB_PATH=/tmp/ux-walkthrough.db \
//   ADMIN_USERNAME=admin ADMIN_PASSWORD=first-boot-pw-1 \
//   EMAIL_TEST_CAPTURE=/tmp/ux-mail.jsonl \
//   PORT=3111 npm run dev
//
//   node scripts/ux-walkthrough.mjs onboarding invite pages workflows
//
// Or let the harness own the server lifecycle (scratch DB, boot, poll-ready,
// teardown; UX_SEED=1 seeds first for a data-rich census, UX_SEED=thin seeds and
// then trims observations to the last ~7 days — the week-old-phone shape):
//
//   node scripts/ux-walkthrough.mjs --serve onboarding pages
//
// Journeys: `onboarding` (fresh-install wizard, admin), `invite` (email invite →
// set-password → member first sign-in), `pages` (screenshot every
// app/(app) route at desktop AND mobile widths — the visual census; dynamic
// `[param]` routes census one representative instance each, see
// scripts/ux-census-routes.mjs), `workflows`
// (quick-log starter set: search, activity, check-in, food, weight, medication),
// `live` (live workout mode: start → set → finish → verify), `dismiss` (dismiss
// a finding, verify it stays dismissed across reload), `dose` (confirm a dose,
// verify persistence), `profiles` (switch acting profile + the read-only member
// experience), `upload` (medical document upload, offline path). Run
// `onboarding` first on a fresh DB — it saves the admin session the later
// journeys reuse. Every run writes an index.html contact sheet next to the
// shots.
//
// Mobile audit (#1510): the `pages` census also records per-route DOM metrics
// (height, first-data offset, table/form/menu counts, h1-scale headings, a
// findings-flood heuristic) into metrics.json; `workflows` (+ dose/dismiss/
// profiles) records tap costs (taps vs typed inputs, span per action; reach
// costs driven through the mobile drawer) into taps.json. Both feed a ranked
// audit.md, and `--baseline <prior shots dir>` diffs a previous run —
// firstData/height growth >15% flags a route, ANY +1 tap flags an action.
//
// Notes discovered the hard way:
//   - EMAIL_TEST_CAPTURE (lib/email.ts) is the deterministic mailbox: every send
//     appends a JSON line there instead of hitting SMTP, so the invite journey
//     runs without a relay. SMTP host/port/from still must be CONFIGURED (any
//     fake values) plus the public URL, or the invite affordance stays hidden —
//     the script does that itself on Settings → Server.
//   - The first request after `next dev` compiles middleware + page and can take
//     minutes on a slow filesystem; the script waits, but don't kill it early.
//   - If Playwright can't find its own browser build, point UX_CHROMIUM at one
//     (e.g. /opt/pw-browsers/chromium in Claude Code's remote environment).
//
// Env knobs: UX_BASE (default http://localhost:3111), UX_SHOTS (default
// data/ux-shots — under gitignored /data), UX_ADMIN_USER / UX_ADMIN_PASS
// (default admin / first-boot-pw-1, match the dev-server env above).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";
import { DYNAMIC_ROUTES, routeSlug } from "./ux-census-routes.mjs";

const BASE = process.env.UX_BASE || "http://localhost:3111";
const SHOTS =
  process.env.UX_SHOTS || path.join(process.cwd(), "data", "ux-shots");
const ADMIN_USER = process.env.UX_ADMIN_USER || "admin";
const ADMIN_PASS = process.env.UX_ADMIN_PASS || "first-boot-pw-1";
const MAIL_FILE = process.env.EMAIL_TEST_CAPTURE || "/tmp/ux-mail.jsonl";
// Invitee fixture — synthetic values only (no real PHI/emails, per repo policy).
const INVITEE = {
  username: "jordan",
  email: "jordan@example.test",
  profileName: "Jordan",
  // Must pass checkPasswordStrength and must NOT contain the username.
  password: "Maple-Grove-84!x",
};

fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log("[ux]", ...a);

// Contact-sheet manifest: every shot lands here; writeContactSheet() renders an
// index.html of thumbnails at the end of the run so 100+ captures are reviewable.
const manifest = [];
let shotSeq = 0;
// Duplicate-capture tripwire: N consecutive byte-identical screenshots almost
// always means an unauthenticated session or a stuck page (it once meant 58
// copies of /login that read as a completed census) — warn loudly.
const recentHashes = [];
async function shot(page, name) {
  const file = `${String(shotSeq++).padStart(2, "0")}-${name}.png`;
  const p = path.join(SHOTS, file);
  await page.screenshot({ path: p, fullPage: true });
  manifest.push({ file, name });
  recentHashes.push(
    crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex")
  );
  if (recentHashes.length > 4) recentHashes.shift();
  if (recentHashes.length === 4 && new Set(recentHashes).size === 1)
    log(
      `WARNING: last 4 screenshots are byte-identical (at ${name}) — unauthenticated session or stuck page?`
    );
}

function writeContactSheet() {
  if (!manifest.length) return;
  const items = manifest
    .map(
      (m) =>
        `<figure><a href="${m.file}"><img loading="lazy" src="${m.file}" alt="${m.name}"></a><figcaption>${m.file}</figcaption></figure>`
    )
    .join("\n");
  fs.writeFileSync(
    path.join(SHOTS, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>ux-walkthrough shots</title>
<style>body{font-family:system-ui;margin:1rem;background:#f5f5f4}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:1rem}
figure{margin:0;background:#fff;border-radius:8px;padding:8px;box-shadow:0 1px 3px rgb(0 0 0/.15)}
img{width:100%;height:220px;object-fit:cover;object-position:top;border-radius:4px}
figcaption{font-size:12px;color:#555;padding-top:6px;word-break:break-all}</style>
<h1>ux-walkthrough — ${manifest.length} captures</h1><main>${items}</main>`
  );
  log(`contact sheet: ${path.join(SHOTS, "index.html")}`);
}

// ---------------------------------------------------------------------------
// Mobile-audit instrumentation (#1510). Two recorders, same seeing-tool ethos:
// they MEASURE, they never assert — the numbers land in metrics.json/taps.json
// + a ranked audit.md, and `--baseline <old metrics dir>` diffs a prior run.
//
// Part 1 — per-route DOM metrics, collected by the pages census on the same
// visits it already makes. The probe runs in-page; every threshold is the
// #1510-pinned value (h1-scale ≥ 20px computed; flood = ≥4 sibling .card
// elements sharing a 24-char text prefix; firstData selector list fixed).
const metricsRows = [];
// Dynamic patterns the census could NOT reach this run (#1544) — an unregistered
// pattern, or a `follow` whose index rendered no detail link (a genuinely empty
// table on the fresh/thin shapes). Reported in audit.md so the gap is visible
// rather than looking like a route that simply doesn't exist.
const unresolvedDynamic = [];
function pageProbe() {
  const top = (el) =>
    el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null;
  const firstData = document.querySelector(
    ".recharts-responsive-container, svg.recharts-surface, table tbody tr, [data-testid*=list] li, .card ul li"
  );
  // Findings-flood heuristic: ≥4 same-parent .card siblings sharing a prefix.
  let floods = 0;
  const byParent = new Map();
  for (const el of document.querySelectorAll("[class*=card]")) {
    const p = el.parentElement;
    if (!p) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push((el.textContent || "").trim().slice(0, 24));
  }
  for (const texts of byParent.values()) {
    const counts = new Map();
    for (const t of texts) {
      if (!t) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    for (const n of counts.values()) if (n >= 4) floods++;
  }
  // Render health (#1544): a detail page that threw renders app/(app)/error.tsx
  // and a missing/inaccessible id renders app/(app)/not-found.tsx — both INSIDE
  // the app shell, so a screenshot of one looks like a plausible page. Detect
  // them by their own markers so the census can say so out loud. Still a
  // measurement, not an assertion: it lands in metrics.json + audit.md.
  const renderFault = document.querySelector('[data-testid="app-not-found"]')
    ? "not-found"
    : [...document.querySelectorAll("h1")].some(
          (h) => (h.textContent || "").trim() === "Something went wrong"
        )
      ? "error-boundary"
      : null;
  return {
    height: document.documentElement.scrollHeight,
    firstData: top(firstData),
    renderFault,
    tables: document.querySelectorAll("table").length,
    forms: document.querySelectorAll("form").length,
    menus: document.querySelectorAll(
      '[data-testid*="overflow"], button[aria-haspopup]'
    ).length,
    h1Scale: [...document.querySelectorAll("h1,h2")].filter(
      (e) => parseFloat(getComputedStyle(e).fontSize) >= 20
    ).length,
    floods,
  };
}

// Part 2 — tap costs. A tap = one pointer gesture; typing one field = one
// "input" (never per-keystroke). Journeys open a span, drive through the
// counting helpers, close it; uninstrumented clicks outside a span cost
// nothing. Coverage is whatever the journeys drive — gaps are logged in
// audit.md, never guessed.
const tapCosts = {};
let tapSpan = null;
function beginTaps(name) {
  tapSpan = { name, taps: 0, inputs: 0 };
}
function endTaps(note) {
  if (!tapSpan) return;
  tapCosts[tapSpan.name] = {
    taps: tapSpan.taps,
    inputs: tapSpan.inputs,
    ...(note ? { note } : {}),
  };
  log(`taps: ${tapSpan.name} = ${tapSpan.taps} taps, ${tapSpan.inputs} inputs`);
  tapSpan = null;
}
async function tapClick(target) {
  if (tapSpan) tapSpan.taps++;
  await target.click();
}
async function tapFill(target, value) {
  if (tapSpan) tapSpan.inputs++;
  await target.fill(value);
}
// A keyboard gesture used as a commit (Enter on a combobox) counts as a tap.
function tapGesture() {
  if (tapSpan) tapSpan.taps++;
}

// Artifact writer, called from the run's finally block. Regressions vs a
// baseline: firstData/height growth >15% flags a route; ANY +1 tap flags an
// action (step-function damage — no percentage threshold, per #1510).
function writeAuditArtifacts(baselineDir) {
  const out = [];
  if (metricsRows.length) {
    fs.writeFileSync(
      path.join(SHOTS, "metrics.json"),
      JSON.stringify(metricsRows, null, 1)
    );
    out.push("metrics.json");
  }
  if (Object.keys(tapCosts).length) {
    fs.writeFileSync(
      path.join(SHOTS, "taps.json"),
      JSON.stringify(tapCosts, null, 1)
    );
    out.push("taps.json");
  }
  if (!out.length && !unresolvedDynamic.length) return;

  const mobile = metricsRows.filter((r) => r.viewport === "mobile");
  const rank = (key, n = 10) =>
    [...mobile]
      .filter((r) => r[key] != null)
      .sort((a, b) => b[key] - a[key])
      .slice(0, n);
  const row = (r, key) => `| ${r.route} | ${r[key]} |`;
  const lines = ["# Mobile audit report", ""];
  // Render health first (#1544) — a route that rendered the error boundary or the
  // 404 boundary produced numbers, but they measure a broken page, so say so
  // before any ranking a reader might otherwise trust.
  const faulted = metricsRows.filter((r) => r.renderFault);
  if (faulted.length) {
    lines.push("## Render faults (page did not render its own content)", "");
    lines.push("| route | viewport | fault | resolved |", "|---|---|---|---|");
    for (const r of faulted)
      lines.push(
        `| ${r.route} | ${r.viewport} | ${r.renderFault} | ${r.resolved ?? ""} |`
      );
    lines.push("");
  }
  if (unresolvedDynamic.length) {
    lines.push("## Unreached dynamic routes (census blind spots)", "");
    lines.push("| route | why |", "|---|---|");
    for (const u of unresolvedDynamic)
      lines.push(`| ${u.pattern} | ${u.why} |`);
    lines.push("");
  }
  if (mobile.length) {
    lines.push("## Worst first-data offsets (px, mobile)", "");
    lines.push("| route | firstData |", "|---|---|");
    for (const r of rank("firstData")) lines.push(row(r, "firstData"));
    lines.push("", "## Tallest pages (px, mobile)", "");
    lines.push("| route | height |", "|---|---|");
    for (const r of rank("height")) lines.push(row(r, "height"));
    lines.push("", "## Most standing forms (mobile)", "");
    lines.push("| route | forms |", "|---|---|");
    for (const r of rank("forms")) lines.push(row(r, "forms"));
    const flooded = mobile.filter((r) => r.floods > 0);
    if (flooded.length) {
      lines.push(
        "",
        "## Findings floods (≥4 sibling cards, shared prefix)",
        ""
      );
      lines.push("| route | floods |", "|---|---|");
      for (const r of flooded) lines.push(row(r, "floods"));
    }
    const multiH1 = mobile.filter((r) => r.h1Scale > 1);
    if (multiH1.length) {
      lines.push("", "## Pages with >1 h1-scale heading", "");
      lines.push("| route | h1Scale |", "|---|---|");
      for (const r of multiH1) lines.push(row(r, "h1Scale"));
    }
  }
  if (Object.keys(tapCosts).length) {
    lines.push("", "## Tap costs", "");
    lines.push("| action | taps | inputs |", "|---|---|---|");
    for (const [name, c] of Object.entries(tapCosts).sort(
      (a, b) => b[1].taps - a[1].taps
    ))
      lines.push(
        `| ${name} | ${c.taps} | ${c.inputs}${c.note ? ` (${c.note})` : ""} |`
      );
  }

  if (baselineDir) {
    lines.push("", "## Baseline diff", "");
    const load = (f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(baselineDir, f), "utf8"));
      } catch {
        return null;
      }
    };
    const oldMetrics = load("metrics.json");
    if (oldMetrics) {
      const key = (r) => `${r.viewport} ${r.route}`;
      const prev = new Map(oldMetrics.map((r) => [key(r), r]));
      for (const r of metricsRows) {
        const o = prev.get(key(r));
        if (!o) continue;
        for (const k of ["firstData", "height"]) {
          if (r[k] != null && o[k] != null && r[k] > o[k] * 1.15)
            lines.push(
              `- REGRESSION ${key(r)}: ${k} ${o[k]} → ${r[k]} (+${Math.round(((r[k] - o[k]) / o[k]) * 100)}%)`
            );
          else if (r[k] != null && o[k] != null && r[k] < o[k] * 0.85)
            lines.push(`- improved ${key(r)}: ${k} ${o[k]} → ${r[k]}`);
        }
      }
    } else lines.push("- no metrics.json in baseline dir");
    const oldTaps = load("taps.json");
    if (oldTaps)
      for (const [name, c] of Object.entries(tapCosts)) {
        const o = oldTaps[name];
        if (o && c.taps > o.taps)
          lines.push(
            `- TAP REGRESSION ${name}: ${o.taps} → ${c.taps} (any +1 flags — annotate the baseline if deliberate)`
          );
      }
  }
  fs.writeFileSync(path.join(SHOTS, "audit.md"), lines.join("\n") + "\n");
  out.push("audit.md");
  log(`audit artifacts: ${out.map((f) => path.join(SHOTS, f)).join(", ")}`);
}

// goto-and-settle. The dev server needs a beat after navigation for hydration
// and streamed data; one tunable knob instead of scattered waitForTimeouts.
async function visit(page, route, ms = 1200) {
  await page.goto(`${BASE}${route}`);
  await page.waitForTimeout(ms);
}

// The honest-completion primitive: poll for a condition, log LOUDLY on failure.
// `locate` is a () => Locator so it re-resolves each attempt.
async function checkVisible(page, locate, failMsg, tries = 8) {
  for (let i = 0; i < tries; i++) {
    if (
      await locate()
        .first()
        .isVisible()
        .catch(() => false)
    )
      return true;
    await page.waitForTimeout(1000);
  }
  log(failMsg);
  return false;
}

// Authenticated-context factory: reuses the saved admin storage state when one
// exists, verifies the session actually works (retrying the sign-in), and
// THROWS on failure so no journey ever drives unauthenticated (the guard the
// census taught us to want). Returns { ctx, page }; caller closes ctx.
async function adminPage(browser, viewport = { width: 1280, height: 900 }) {
  const state = path.join(SHOTS, "admin-state.json");
  const ctx = await browser.newContext({
    viewport,
    storageState: fs.existsSync(state) ? state : undefined,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(Number(process.env.UX_TIMEOUT_MS) || 45_000);
  await page.goto(`${BASE}/`);
  for (let i = 0; page.url().includes("login") && i < 3; i++) {
    await signIn(page, ADMIN_USER, ADMIN_PASS);
    await page.goto(`${BASE}/`);
  }
  if (page.url().includes("login")) {
    await ctx.close();
    throw new Error("adminPage: could not authenticate after 3 attempts");
  }
  return { ctx, page };
}

async function signIn(page, username, password) {
  await page.goto(`${BASE}/login`);
  // A pre-hydration submit is silently swallowed, and on a cold filesystem
  // hydration can outlast any fixed sleep (a 2s guess lost repeatedly: the
  // click landed, NO POST ever fired, and the census aborted "unauthenticated").
  // The e2e suite's settledClick answer, inlined — but verify the REQUEST,
  // not the response: the login POST has been measured taking 45s–5min to
  // answer on a cold filesystem, and a response-keyed re-click aborts the
  // in-flight submission and restarts it forever. The request event fires
  // the moment the click actually lands, so it's the honest "click took"
  // signal at any server speed.
  await page.waitForTimeout(2000);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  for (let i = 0; i < 8; i++) {
    const fired = page
      .waitForRequest(
        (r) => r.method() === "POST" && r.url().includes("/login"),
        { timeout: 8_000 }
      )
      .catch(() => null);
    await page.click('button[type="submit"]').catch(() => {});
    if (await fired) break;
  }
  await page
    // The POST + its redirect self-fetch can take minutes (the server compiles
    // the target page inside the 303) — give the URL change page-load patience.
    .waitForURL((u) => !u.pathname.startsWith("/login"), {
      timeout: Math.max(90_000, Number(process.env.UX_TIMEOUT_MS) || 0),
    })
    .catch(() => {});
  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------
// Journey: fresh-install onboarding (admin walks the 7-step wizard).
// Resumable: detects whichever step is showing and proceeds from there.
async function onboardingJourney(browser) {
  const page = await (
    await browser.newContext({ viewport: { width: 1280, height: 900 } })
  ).newPage();
  page.setDefaultTimeout(Number(process.env.UX_TIMEOUT_MS) || 45_000);

  await page.goto(`${BASE}/`);
  await page.waitForURL(/login/);
  await shot(page, "login");
  await signIn(page, ADMIN_USER, ADMIN_PASS);
  log("signed in:", page.url());

  await page.goto(`${BASE}/onboarding`);
  const steps = [
    "onboarding-profile-path",
    "onboarding-outcomes",
    "onboarding-basics",
    "onboarding-first-value",
    "onboarding-dashboard",
    "onboarding-notifications",
    "onboarding-finish",
  ];
  for (let round = 0; round < 10; round++) {
    await page.waitForTimeout(1000);
    let current = null;
    for (const id of steps) {
      if (await page.getByTestId(id).count()) {
        current = id;
        break;
      }
    }
    if (!current) {
      log("no wizard step visible at", page.url());
      break;
    }
    const sec = page.getByTestId(current);
    log("wizard step:", current);
    await shot(page, current);

    if (current === "onboarding-profile-path") {
      await sec.getByLabel("Set up my own profile").check();
      await sec
        .getByRole("button", { name: /Save profile choice|Next/ })
        .first()
        .click();
    } else if (current === "onboarding-outcomes") {
      await sec.getByLabel("Explore everything").check();
      await sec.getByRole("button", { name: "Next" }).click();
    } else if (current === "onboarding-basics") {
      await page.getByLabel("Or approximate age").fill("38");
      await sec.getByRole("button", { name: "Next" }).click();
    } else if (current === "onboarding-first-value") {
      await sec
        .getByRole("button", { name: /Next|Skip/ })
        .first()
        .click();
    } else if (current === "onboarding-dashboard") {
      await sec
        .getByRole("button", { name: /Next|Save/ })
        .first()
        .click();
    } else if (current === "onboarding-notifications") {
      // The radio labels wrap multi-line descriptions, so match by body text.
      await page
        .locator("label")
        .filter({ hasText: "one morning summary" })
        .click();
      await sec.getByRole("button", { name: "Next" }).click();
    } else if (current === "onboarding-finish") {
      await sec
        .getByRole("button", { name: /Finish|Done|dashboard/i })
        .or(sec.getByRole("link", { name: /Finish|Done|dashboard/i }))
        .first()
        .click();
      await page.waitForTimeout(2000);
      break;
    }
  }
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(1500);
  await shot(page, "dashboard-after-onboarding");
  log("onboarding journey done:", page.url());
  await page
    .context()
    .storageState({ path: path.join(SHOTS, "admin-state.json") });
  await page.context().close();
}

// ---------------------------------------------------------------------------
// Journey: invite another user (admin configures email, creates login + grant,
// invitee follows the emailed set-password link and signs in).
async function inviteJourney(browser) {
  const adminCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    storageState: fs.existsSync(path.join(SHOTS, "admin-state.json"))
      ? path.join(SHOTS, "admin-state.json")
      : undefined,
  });
  const page = await adminCtx.newPage();
  page.setDefaultTimeout(Number(process.env.UX_TIMEOUT_MS) || 45_000);
  await page.goto(`${BASE}/settings/family`);
  if (page.url().includes("login")) {
    await signIn(page, ADMIN_USER, ADMIN_PASS);
    await page.goto(`${BASE}/settings/family`);
  }
  await page.waitForTimeout(1500);
  await shot(page, "family-before");

  // Email prerequisites: public URL + (fake) SMTP config; sends are captured to
  // EMAIL_TEST_CAPTURE so no relay is contacted.
  await page.goto(`${BASE}/settings/server`);
  await page.waitForTimeout(1500);
  const pub = page.getByPlaceholder("https://your-app.example.com");
  await pub.fill(BASE);
  await pub.press("Tab");
  await page
    .getByRole("button", { name: "Save" })
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(800);
  await page.getByTestId("smtp-host").fill("localhost");
  await page.getByTestId("smtp-port").fill("2525");
  await page.getByTestId("smtp-from").fill("allos@example.test");
  await page.getByTestId("smtp-apply").click();
  await page.waitForTimeout(1500);
  await shot(page, "server-email-configured");

  // Profile + login + invite.
  await page.goto(`${BASE}/settings/family`);
  await page.waitForTimeout(1500);
  await page
    .getByPlaceholder("Name", { exact: true })
    .fill(INVITEE.profileName);
  await page.getByRole("button", { name: "Add" }).first().click();
  await page.waitForTimeout(1000);
  await page.getByPlaceholder("Username").fill(INVITEE.username);
  // A password is currently REQUIRED even with the invite box checked (#1434);
  // this relay value is what the UI forces the admin to invent.
  await page.getByPlaceholder("Password").fill("Relay-Temp-7pw!");
  await page.getByPlaceholder("Email (optional)").fill(INVITEE.email);
  await page.getByTestId("create-invite").check();
  await shot(page, "family-create-login");
  await page.getByRole("button", { name: "Create login" }).click();
  await page.waitForTimeout(2000);
  await shot(page, "family-after-create");

  // Grant the profile: check the matrix cell, then Save access — WITHOUT this
  // the invitee's sign-in silently bounces (#1434).
  const cell = page
    .getByTestId(new RegExp(`grant-cell-${INVITEE.username}-`))
    .first();
  await cell.scrollIntoViewIfNeeded();
  const box = cell.locator('input[type="checkbox"]');
  await ((await box.count()) ? box.first() : cell)
    .check?.()
    .catch(() => cell.click());
  await page.getByRole("button", { name: "Save access" }).click();
  await page.waitForTimeout(1500);
  await shot(page, "family-granted");

  // Pull the invite link from the captured mailbox.
  const mail = fs
    .readFileSync(MAIL_FILE, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const invite = mail[mail.length - 1];
  const link = invite.text.match(/https?:\/\/\S+/)?.[0];
  log("invite email:", invite.subject, "→", link);
  if (!link) throw new Error("no set-password link found in captured mail");

  // Invitee: set password, then first sign-in.
  const invCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const inv = await invCtx.newPage();
  inv.setDefaultTimeout(Number(process.env.UX_TIMEOUT_MS) || 45_000);
  await inv.goto(link.replace(/^https?:\/\/[^/]+/, BASE));
  await inv.waitForTimeout(1200);
  await shot(inv, "invitee-set-password");
  await inv.getByTestId("new-password").fill(INVITEE.password);
  await inv.getByTestId("confirm-password").fill(INVITEE.password);
  await inv.getByRole("button", { name: /Set password/ }).click();
  await inv.waitForTimeout(2000);
  await shot(inv, "invitee-password-set");
  await signIn(inv, INVITEE.username, INVITEE.password);
  await shot(inv, "invitee-first-login");
  log("invite journey done — invitee landed at:", inv.url());
  await invCtx.close();
  await adminCtx.close();
}

// ---------------------------------------------------------------------------
// Dynamic-route resolution (#1544). Each `[param]` pattern gets ONE instance,
// from scripts/ux-census-routes.mjs: a literal slug off a static enum, or the
// first detail link found on an index route (which also proves index → detail).
// Every failure is recorded LOUDLY in unresolvedDynamic — a route is never
// silently dropped from the manifest.
async function resolveDynamicRoutes(page, patterns) {
  const resolved = new Map();
  for (const pattern of patterns) {
    const entry = DYNAMIC_ROUTES.find((d) => d.pattern === pattern);
    if (!entry) {
      const why = "no DYNAMIC_ROUTES entry in scripts/ux-census-routes.mjs";
      log(`BLIND SPOT: ${pattern} — ${why}; NOT censused`);
      unresolvedDynamic.push({ pattern, why });
      continue;
    }
    if (entry.strategy === "literal") {
      resolved.set(pattern, {
        target: entry.instance,
        via: `literal (${entry.enumSource})`,
      });
      continue;
    }
    let hit = null;
    for (const from of entry.from) {
      try {
        await page.goto(`${BASE}${from}`);
        await page.waitForTimeout(1500);
        const hrefs = await page.$$eval("a[href]", (as) =>
          as.map((a) => a.getAttribute("href"))
        );
        const found = hrefs.find(
          (h) => h && entry.match.test(h.split(/[?#]/)[0])
        );
        if (found) {
          hit = { target: found.split("#")[0], via: `first link on ${from}` };
          break;
        }
        log(`  ${pattern}: no matching detail link on ${from}`);
      } catch (err) {
        log(
          `  ${pattern}: index ${from} failed — ${err.message.split("\n")[0]}`
        );
      }
    }
    if (hit) resolved.set(pattern, hit);
    else {
      const why = `no detail link on ${entry.from.join(" / ")} (empty table on this data shape?)`;
      log(`BLIND SPOT: ${pattern} — ${why}; NOT censused`);
      unresolvedDynamic.push({ pattern, why });
    }
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Journey: every page, desktop + mobile. Routes are enumerated from the
// filesystem (app/(app)/**/page.tsx), so the census stays current as pages are
// added. Dynamic `[param]` segments are resolved to one representative instance
// each through DYNAMIC_ROUTES (#1544) instead of being skipped — detail pages
// are exactly where density problems concentrate. Redirect routes screenshot
// their target — that's fine, the point is "what does a user see at every URL".
async function pagesJourney(browser) {
  const appDir = path.join(process.cwd(), "app", "(app)");
  const routes = [];
  const walk = (dir, route) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) {
        if (e.name === "page.tsx") routes.push(route || "/");
        continue;
      }
      walk(path.join(dir, e.name), `${route}/${e.name}`);
    }
  };
  walk(appDir, "");
  // UX_ROUTES: comma-separated route prefixes to census a SUBSET (e.g.
  // "/trends,/upcoming" to audit one hub, or to keep a run tractable on a
  // pathologically slow dev filesystem). Unset = every route.
  const only = (process.env.UX_ROUTES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const keep = (r) =>
    !only.length || only.some((p) => r === p || r.startsWith(p));
  const picked = routes.filter((r) => !r.includes("[")).filter(keep);
  const dynamicPatterns = routes.filter((r) => r.includes("[")).filter(keep);
  const staticTotal = routes.filter((r) => !r.includes("[")).length;
  if (only.length)
    log(
      `pages census: ${picked.length} of ${staticTotal} static routes + ${dynamicPatterns.length} dynamic (UX_ROUTES=${only.join(",")})`
    );
  else
    log(
      `pages census: ${picked.length} static routes + ${dynamicPatterns.length} dynamic patterns`
    );

  // Resolved once (in the first authenticated viewport) and reused for the
  // second, so the follow-the-index cost is paid a single time per run.
  let dynamicTargets = null;
  const state = path.join(SHOTS, "admin-state.json");
  for (const [tag, viewport] of [
    ["desktop", { width: 1280, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const ctx = await browser.newContext({
      viewport,
      storageState: fs.existsSync(state) ? state : undefined,
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(Number(process.env.UX_TIMEOUT_MS) || 45_000);
    // No stored admin session → sign in once. VERIFY it took: a silently
    // failed login here once produced 58 byte-identical /login screenshots
    // that looked like a completed census — abort loudly instead.
    await page.goto(`${BASE}/`);
    for (
      let attempt = 0;
      page.url().includes("login") && attempt < 3;
      attempt++
    ) {
      await signIn(page, ADMIN_USER, ADMIN_PASS);
      await page.goto(`${BASE}/`);
    }
    if (page.url().includes("login")) {
      log(
        `FAILED (${tag}): could not authenticate — skipping this viewport's census entirely`
      );
      await ctx.close();
      continue;
    }
    if (!dynamicTargets) {
      dynamicTargets = await resolveDynamicRoutes(page, dynamicPatterns);
      for (const [pattern, r] of dynamicTargets)
        log(`resolved ${pattern} → ${r.target} (${r.via})`);
    }
    // Static routes census themselves; a dynamic pattern censuses its resolved
    // instance but is KEYED by the pattern — ids differ run to run, and both the
    // shot filenames and the `--baseline` metrics diff need a stable key.
    const visits = [
      ...picked.map((route) => ({ route, target: route })),
      ...[...dynamicTargets].map(([route, r]) => ({ route, target: r.target })),
    ].sort((a, b) => a.route.localeCompare(b.route));
    for (const { route, target } of visits) {
      const slug = routeSlug(route);
      try {
        await page.goto(`${BASE}${target}`);
        await page.waitForTimeout(1200);
        await shot(page, `page-${tag}-${slug}`);
        // #1510 Part 1: the metrics probe rides the census visit it already made.
        const m = await page.evaluate(pageProbe);
        metricsRows.push({
          route,
          ...(target === route ? {} : { resolved: target }),
          viewport: tag,
          ...m,
        });
        if (m.renderFault)
          log(
            `RENDER FAULT ${route} (${tag}) at ${target}: ${m.renderFault} — the shot is a boundary, not the page`
          );
      } catch (err) {
        log(`FAILED to shoot ${route} (${tag}): ${err.message.split("\n")[0]}`);
      }
    }
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// #1510 Part 2: reach costs — taps from the logged-in dashboard to each hub
// (and two second-level examples), measured by DRIVING the mobile drawer,
// never inferred from the nav model. A hub whose link isn't reachable in the
// open drawer (relevance-gated / grouped) records as unmeasured, loudly.
async function measureReachCosts(browser) {
  const state = path.join(SHOTS, "admin-state.json");
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: fs.existsSync(state) ? state : undefined,
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(Number(process.env.UX_TIMEOUT_MS) || 20_000);
  await page.goto(`${BASE}/`);
  if (page.url().includes("login")) {
    await signIn(page, ADMIN_USER, ADMIN_PASS);
    await page.goto(`${BASE}/`);
  }
  const hubs = [
    ["Training", "/training"],
    ["Nutrition", "/nutrition"],
    ["Timeline", "/timeline"],
    ["Trends", "/trends"],
    ["Sleep", "/sleep"],
    ["Upcoming", "/upcoming"],
    ["Medications", "/medications"],
    ["Longevity", "/longevity"],
  ];
  for (const [name, href] of hubs) {
    await page.goto(`${BASE}/`);
    await page.waitForTimeout(800);
    beginTaps(`reach: ${name}`);
    await tapClick(page.getByRole("button", { name: "Open menu" }).first());
    await page.waitForTimeout(500);
    const link = page.getByRole("link", { name, exact: true }).first();
    if (await link.isVisible().catch(() => false)) {
      await tapClick(link);
      await page.waitForTimeout(800);
      if (page.url().includes(href)) endTaps();
      else
        endTaps(`landed on ${new URL(page.url()).pathname}, expected ${href}`);
    } else {
      endTaps("link not visible in open drawer (grouped/gated) — unmeasured");
      await page.keyboard.press("Escape");
    }
  }
  // Second-level examples (the #1510-pinned pair): Trends → Body, Records → Visits.
  await page.goto(`${BASE}/trends`);
  await page.waitForTimeout(1000);
  beginTaps("reach: Trends → Body (from Trends)");
  const bodyTab = page.getByRole("link", { name: "Body", exact: true }).first();
  if (await bodyTab.isVisible().catch(() => false)) {
    await tapClick(bodyTab);
    await page.waitForTimeout(800);
    endTaps();
  } else endTaps("Body tab not visible — unmeasured");
  await page.goto(`${BASE}/records/problems`);
  await page.waitForTimeout(1000);
  beginTaps("reach: Records → Visits (from Records)");
  const visitsTab = page
    .getByRole("link", { name: "Visits", exact: true })
    .first();
  if (await visitsTab.isVisible().catch(() => false)) {
    await tapClick(visitsTab);
    await page.waitForTimeout(800);
    endTaps();
  } else endTaps("Visits tab not visible — unmeasured");
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Journey: common workflows — a starter set, each a short "do the thing a user
// does" sequence with shots before/after. Add more by following this shape;
// keep each step honest (log loudly when a step can't complete rather than
// silently skipping — this is a seeing tool, a blind spot must be visible).
// Tap spans here are SURFACE-LOCAL (they count from the action's owning page);
// total user cost = the hub's reach cost + the action's span — audit.md says so.
async function workflowsJourney(browser) {
  // #1510 Part 2 — reach costs first (mobile drawer, measured by driving).
  await measureReachCosts(browser);

  const { ctx, page } = await adminPage(browser);

  // Workflow: global search (the palette deep-links everywhere).
  beginTaps("search → open first result");
  await tapClick(page.getByRole("button", { name: /Search/ }).first());
  await page.waitForTimeout(500);
  await page.keyboard.type("vitamin");
  if (tapSpan) tapSpan.inputs++; // the query = one input
  await page.waitForTimeout(1200);
  await shot(page, "workflow-search-results");
  // Scope the option fallback to the palette dialog — an unscoped role=option
  // matches the sidebar calendar's hidden native <select> options, which pass
  // count() but can never be clicked (verified the hard way: the click retried
  // for 45s against <option>Jan</option> and killed the whole run).
  const paletteResult = page
    .getByTestId("palette-result")
    .or(page.getByRole("dialog").getByRole("option"))
    .first();
  if (await paletteResult.isVisible().catch(() => false)) {
    try {
      await tapClick(paletteResult);
      await page.waitForTimeout(1200);
      endTaps();
      await shot(page, "workflow-search-opened");
    } catch {
      endTaps("result visible but not clickable — open-result tap unmeasured");
      await page.keyboard.press("Escape");
    }
  } else {
    endTaps("no clickable result found — open-result tap unmeasured");
    await page.keyboard.press("Escape");
  }

  // Workflow: quick-log an activity (the sidebar's primary action).
  beginTaps("log activity, retro (from Dashboard)");
  await tapClick(page.getByRole("button", { name: "Log activity" }).first());
  await page.waitForTimeout(1000);
  await shot(page, "workflow-log-activity-editor");
  const form = page.getByTestId("activity-form");
  if (await form.count()) {
    // The form's FIRST input is the session title — the activity picker is the
    // "What did you do?" combobox, and its suggestion must be COMMITTED
    // (Enter / option click) or Done just closes an empty draft; the editor
    // shows "Not saved — Add an activity to start" until one is added
    // (verified the hard way: activities table stayed empty).
    const box = form.getByPlaceholder(/What did you do/);
    await tapFill(box, "Walking").catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, "workflow-log-activity-filled");
    // Scope to the editor — an unscoped role=option match hits the sidebar
    // calendar's native <select> options.
    const option = form.locator('[role="option"], [role="listbox"] li').first();
    if (await option.count()) await tapClick(option);
    else {
      tapGesture(); // Enter as the commit gesture
      await box.press("Enter");
    }
    await page.waitForTimeout(800);
    // A cardio part needs a distance or duration before the draft saves
    // ("Not saved — Enter a distance, duration, or a start & end time").
    await tapFill(form.getByTestId("cardio-duration"), "30").catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, "workflow-log-activity-committed");
    const done = page.getByRole("button", { name: "Done" });
    if (await done.count()) {
      await tapClick(done.first());
      endTaps();
      await page.waitForTimeout(1200);
      await shot(page, "workflow-log-activity-done");
      // Honest completion check: the new activity should be visible on the
      // Training journal. A missing entry means the log did NOT save — say so.
      await page.goto(`${BASE}/training`);
      await page.waitForTimeout(1200);
      await shot(page, "workflow-log-activity-journal");
      const visible = await page
        .getByText(/Walking/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible)
        log(
          "log-activity: 'Walking' NOT visible on /training — the log likely did not save; check shots"
        );
    } else {
      endTaps("incomplete — no Done button");
      log("log-activity: no Done button found — left editor open (see shots)");
      await page.keyboard.press("Escape");
    }
  } else {
    endTaps("incomplete — editor did not open");
    log("log-activity: editor did not open — check shots");
  }

  // Workflow: daily check-in (tap a mood on the dashboard card).
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(2000);
  const checkin = page.getByTestId("how-are-you-card");
  if (await checkin.count()) {
    await checkin.scrollIntoViewIfNeeded();
    await shot(page, "workflow-checkin-before");
    beginTaps("mood check-in (on Dashboard)");
    await tapClick(checkin.getByTestId("mood-tap-4"));
    endTaps();
    await page.waitForTimeout(1500);
    await shot(page, "workflow-checkin-after");
    if (!(await checkin.getByTestId("mood-server-logged").count()))
      log("checkin: mood tap did not reach the server — check shots");
  } else {
    log("checkin: how-are-you-card not on dashboard — check shots");
  }

  // Workflow: log a food group serving (Nutrition → Food tab one-tap bar).
  await page.goto(`${BASE}/nutrition`);
  await page.waitForTimeout(1500);
  const foodBar = page.getByTestId("food-log-bar");
  if (await foodBar.count()) {
    await shot(page, "workflow-food-before");
    beginTaps("log food serving (on Nutrition)");
    await tapClick(page.getByTestId("log-nuts_seeds"));
    endTaps();
    await page.waitForTimeout(1500);
    await shot(page, "workflow-food-after");
    // The undo affordance only exists once today's serving is recorded.
    if (!(await page.getByTestId("undo-nuts_seeds").count()))
      log(
        "log-food: no undo affordance after logging — the serving may not have saved"
      );
  } else {
    log("log-food: food-log-bar not found — check shots");
  }

  // Workflow: log a weight (Trends → Body quick-add).
  await page.goto(`${BASE}/trends?tab=body`);
  await page.waitForTimeout(1500);
  const weight = page.locator("#bm-weight");
  if (await weight.count()) {
    await weight.scrollIntoViewIfNeeded();
    await shot(page, "workflow-weight-before");
    beginTaps("log weight (on Trends → Body)");
    await tapFill(weight, "82");
    await tapClick(page.getByRole("button", { name: "Save entry" }));
    endTaps();
    // The history row lands after the server revalidation round-trips — poll
    // instead of a single racy check (a false "not saved" here cried wolf once).
    let saved = false;
    for (let i = 0; i < 8 && !saved; i++) {
      await page.waitForTimeout(1000);
      saved = await page
        .getByText(/82(\.\d)?\s*kg/)
        .first()
        .isVisible()
        .catch(() => false);
    }
    await shot(page, "workflow-weight-after");
    if (!saved)
      log(
        "log-weight: 82 kg not visible after save — the entry may not have saved"
      );
  } else {
    log("log-weight: quick-add weight field not found — check shots");
  }

  // Workflow: quick-add a medication (Medications → Add medication → Quick add).
  await page.goto(`${BASE}/medications`);
  await page.waitForTimeout(1500);
  await shot(page, "workflow-med-before");
  const medToggle = page.getByTestId("medication-add-toggle");
  if (await medToggle.count()) {
    beginTaps("quick-add medication (on Medications)");
    await tapClick(medToggle);
    await page.waitForTimeout(800);
    const quick = page.getByTestId("quick-add-medication");
    if (await quick.count()) {
      await tapFill(quick.getByPlaceholder(/Ibuprofen/), "Ibuprofen");
      await tapFill(quick.getByTestId("quick-add-amount"), "200 mg");
      await shot(page, "workflow-med-filled");
      await tapClick(quick.getByRole("button", { name: "Quick add" }));
      endTaps();
      await page.waitForTimeout(2000);
      await shot(page, "workflow-med-added");
      const visible = await page
        .getByText("Ibuprofen")
        .first()
        .isVisible()
        .catch(() => false);
      if (!visible)
        log(
          "add-medication: Ibuprofen not visible after Quick add — may not have saved"
        );
    } else {
      endTaps("incomplete — quick-add form did not open");
      log("add-medication: quick-add form did not open — check shots");
    }
  } else {
    log("add-medication: Add medication toggle not found — check shots");
  }

  await ctx.close();
}

// ---------------------------------------------------------------------------
// Journey: live workout mode (#340) — start, log a set, finish, verify saved.
async function liveWorkoutJourney(browser) {
  const { ctx, page } = await adminPage(browser);
  await visit(page, "/training");
  const start = page.getByRole("main").getByTestId("start-workout");
  if (!(await start.count())) {
    log("live-workout: no Start workout button on /training — check shots");
    await shot(page, "live-no-start");
    return ctx.close();
  }
  await start.click();
  await page.waitForTimeout(1000);
  await shot(page, "live-panel-open");
  if (!(await page.getByTestId("live-workout-panel").count())) {
    log("live-workout: live panel did not open — check shots");
    return ctx.close();
  }
  // Pick an exercise (commit the combobox suggestion), log one set.
  await page.getByPlaceholder(/What did you do/).fill("Back Squat");
  await page
    .getByRole("listbox")
    .getByRole("button")
    .filter({ hasText: "Back Squat" })
    .first()
    .click();
  await page.waitForTimeout(800);
  // A set needs BOTH weight and reps or the editor flags "Finish or clear the
  // highlighted set" and the session won't save it (learned from the shots).
  const weight = page.getByTestId("set1-weight");
  if (await weight.count()) await weight.fill("60");
  await page
    .getByTestId("set1-reps-stepper")
    .getByRole("spinbutton")
    .fill("5")
    .catch(() => log("live-workout: reps input not found"));
  await shot(page, "live-set-logged");
  await page
    .getByRole("button", { name: /Add set/ })
    .first()
    .click()
    .catch(() => log("live-workout: 'Add set' not found"));
  await page.waitForTimeout(800);
  await shot(page, "live-rest-timer");
  await page.getByTestId("finish-workout").click();
  await page.waitForTimeout(800);
  await shot(page, "live-finish-step");
  const save = page.getByTestId("recap-save");
  if (await save.count()) await save.click();
  await page.waitForTimeout(1500);
  await shot(page, "live-after-save");
  await visit(page, "/training");
  await checkVisible(
    page,
    () => page.getByText("Back Squat"),
    "live-workout: 'Back Squat' NOT on the journal after finish — session may not have saved"
  );
  await shot(page, "live-journal-after");
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Journey: dismiss a coaching observation and verify the dismissal STICKS
// across a reload — the dedupeKey dismissal bus is the app's most load-bearing
// invariant ("dismiss once, silence everywhere").
async function dismissFindingJourney(browser) {
  const { ctx, page } = await adminPage(browser);
  await visit(page, "/", 2000);
  const dismiss = page.getByRole("button", { name: /^Dismiss / }).first();
  if (!(await dismiss.count())) {
    log(
      "dismiss-finding: no dismissible finding on the dashboard — check shots"
    );
    await shot(page, "dismiss-none-available");
    return ctx.close();
  }
  const label = await dismiss.getAttribute("aria-label");
  await dismiss.scrollIntoViewIfNeeded();
  await shot(page, "dismiss-before");
  beginTaps("dismiss finding (on Dashboard)");
  await tapClick(dismiss);
  endTaps();
  await page.waitForTimeout(1500);
  await shot(page, "dismiss-after");
  if (await page.getByRole("button", { name: label, exact: true }).count())
    log(`dismiss-finding: "${label}" still present after dismissing`);
  await visit(page, "/", 2000);
  await shot(page, "dismiss-after-reload");
  if (await page.getByRole("button", { name: label, exact: true }).count())
    log(
      `dismiss-finding: "${label}" CAME BACK after reload — dismissal did not persist`
    );
  else log(`dismiss-finding: "${label}" dismissed and stayed dismissed`);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Journey: confirm a dose from the Medications Today panel and verify the
// state change persists across a reload. dose-take toggles taken/not-taken;
// a prior same-day run may have left it taken — that's handled, not hidden.
async function doseJourney(browser) {
  const { ctx, page } = await adminPage(browser);
  await visit(page, "/medications", 1500);
  const take = page.getByTestId("dose-take").first();
  if (!(await take.count())) {
    log("dose-confirm: no dose-take control on /medications — check shots");
    await shot(page, "dose-none-available");
    return ctx.close();
  }
  const before = await take.getAttribute("aria-label");
  if (before === "Mark not taken")
    log("dose-confirm: dose already taken today (prior run) — toggling anyway");
  await shot(page, "dose-before");
  beginTaps("confirm dose (on Medications)");
  await tapClick(take);
  endTaps();
  await page.waitForTimeout(1500);
  await shot(page, "dose-after");
  const after = await page
    .getByTestId("dose-take")
    .first()
    .getAttribute("aria-label");
  if (after === before)
    log(
      `dose-confirm: aria-label did not change ("${before}") — tap may not have registered`
    );
  await visit(page, "/medications", 1500);
  const persisted = await page
    .getByTestId("dose-take")
    .first()
    .getAttribute("aria-label");
  await shot(page, "dose-after-reload");
  if (persisted === before)
    log(
      "dose-confirm: state REVERTED after reload — the write did not persist"
    );
  else log(`dose-confirm: persisted ("${before}" → "${persisted}")`);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Journey: profile switching + the read-only experience. As admin: switch the
// acting profile and verify the data actually changes. Then flip the member's
// grant to read-only, sign in as them, verify the read-only badge, restore.
async function profilesJourney(browser) {
  const { ctx, page } = await adminPage(browser);

  // -- Switch acting profile: medications differ per profile (Ibuprofen
  //    belongs to profile 1), so the list is the data-isolation probe.
  await visit(page, "/medications", 1500);
  await shot(page, "profiles-acting-admin");
  beginTaps("switch acting profile");
  await tapClick(page.getByTestId("user-menu-trigger").first());
  await page.waitForTimeout(600);
  await shot(page, "profiles-menu-open");
  const switchTo = page.getByTestId("switch-to-2");
  if (await switchTo.count()) {
    await tapClick(switchTo);
    endTaps();
    await page.waitForTimeout(2000);
    await visit(page, "/medications", 1500);
    await shot(page, "profiles-acting-jordan");
    if (
      await page
        .getByText("Ibuprofen")
        .first()
        .isVisible()
        .catch(() => false)
    )
      log(
        "profile-switch: Ibuprofen still visible while acting as profile 2 — DATA LEAK, investigate immediately"
      );
    else
      log("profile-switch: profile 2 sees no profile-1 medications (correct)");
    // switch back
    await page.getByTestId("user-menu-trigger").first().click();
    await page.waitForTimeout(600);
    await page.getByTestId("switch-to-1").click();
    await page.waitForTimeout(1500);
  } else {
    endTaps("incomplete — switch-to-2 not in menu");
    log("profile-switch: switch-to-2 not in the profile menu — check shots");
    await page.keyboard.press("Escape");
  }

  // -- Read-only member: set jordan's grant on profile 2 to read-only. The
  //    Access card collapses each login's matrix behind an Edit button — expand
  //    it first (grant-access-* selects don't exist until then).
  const openGrantEditor = async () => {
    await visit(page, "/settings/family", 1500);
    if (!(await page.getByTestId("grant-access-jordan-2").count()))
      await page
        .getByRole("button", { name: "Edit" })
        .last()
        .click()
        .catch(() => {});
    await page.waitForTimeout(800);
    return page.getByTestId("grant-access-jordan-2");
  };
  let level = await openGrantEditor();
  if (!(await level.count())) {
    log("read-only: grant level select not found — skipping read-only leg");
    await shot(page, "readonly-no-select");
    return ctx.close();
  }
  await level.selectOption("read");
  await page.getByRole("button", { name: "Save access" }).click();
  await page.waitForTimeout(1500);
  await shot(page, "readonly-grant-set");

  const memberCtx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const member = await memberCtx.newPage();
  member.setDefaultTimeout(Number(process.env.UX_TIMEOUT_MS) || 45_000);
  await signIn(member, INVITEE.username, INVITEE.password);
  await member.waitForTimeout(1500);
  await shot(member, "readonly-member-home");
  if (await member.getByTestId("read-only-badge").count())
    log("read-only: badge visible for the read-only member (correct)");
  else
    log(
      "read-only: read-only-badge NOT visible for a member with a read grant — check shots"
    );
  await memberCtx.close();

  // Restore write access so later runs keep their fixtures.
  level = await openGrantEditor();
  if (await level.count()) {
    await level.selectOption("write");
    await page.getByRole("button", { name: "Save access" }).click();
    await page.waitForTimeout(1200);
  } else log("read-only: could not restore write grant — restore manually");
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Journey: upload a medical document (offline path — with no ANTHROPIC_API_KEY
// the documented degradation is stored-but-not-extracted).
async function uploadJourney(browser) {
  const { ctx, page } = await adminPage(browser);
  // Minimal one-page PDF fixture, generated on the fly (synthetic, no PHI).
  const pdfPath = path.join(SHOTS, "fixture-upload.pdf");
  fs.writeFileSync(
    pdfPath,
    `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj
xref
0 4
0000000000 65535 f
trailer<</Size 4/Root 1 0 R>>
%%EOF`
  );
  await visit(page, "/data", 1500);
  await page
    .getByRole("tab", { name: /File upload/i })
    .or(page.getByRole("link", { name: /File upload/i }))
    .or(page.getByRole("button", { name: /File upload/i }))
    .first()
    .click()
    .catch(() => log("upload: File upload tab not found — trying inline form"));
  await page.waitForTimeout(1000);
  const input = page.getByTestId("medical-upload-input");
  if (!(await input.count())) {
    log("upload: medical-upload-input not found — check shots");
    await shot(page, "upload-no-input");
    return ctx.close();
  }
  await input.setInputFiles(pdfPath);
  await page.waitForTimeout(500);
  await shot(page, "upload-file-chosen");
  // testid, not name — the "File upload (incl. CSV)" tab also matches "Upload".
  await page.getByTestId("medical-upload-submit").click();
  await checkVisible(
    page,
    () => page.getByText(/Upload received|fixture-upload/),
    "upload: no receipt message or document listing appeared — upload may have failed"
  );
  await shot(page, "upload-after");
  await ctx.close();
}

// ---------------------------------------------------------------------------
// Journey: upload a synthetic CCD and watch the STRUCTURED import path land
// real records (unlike the PDF journey's store-only path, CCD parsing is
// deterministic — no API key needed). The fixture reuses the section/entry
// shapes the repo's own CDA test fixtures prove parseable (Results 30954-2,
// Immunizations 11369-6); every value is synthetic (fictional LOINCs, Test
// Patient) per the no-PHI rule.
const CCD_FIXTURE = `<?xml version="1.0"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <effectiveTime value="20260601"/>
  <recordTarget><patientRole><patient>
    <name><given>Test</given><family>Patient</family></name>
    <birthTime value="19900101"/>
  </patient></patientRole></recordTarget>
  <component><structuredBody>
    <component><section>
      <templateId root="2.16.840.1.113883.10.20.22.2.3.1"/>
      <code code="30954-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Results</title>
      <entry><observation classCode="OBS" moodCode="EVN">
        <code code="99999-9" codeSystem="2.16.840.1.113883.6.1" codeSystemName="LOINC" displayName="Esoteric Marker XYZ"/>
        <effectiveTime value="20260601"/>
        <value xsi:type="PQ" value="88.0" unit="U/mL"/>
        <interpretationCode code="H" codeSystem="2.16.840.1.113883.5.83"/>
        <referenceRange><observationRange>
          <value xsi:type="IVL_PQ"><low value="10.0" unit="U/mL"/><high value="40.0" unit="U/mL"/></value>
        </observationRange></referenceRange>
      </observation></entry>
    </section></component>
    <component><section>
      <code code="11369-6" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Immunizations</title>
      <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
        <effectiveTime value="20250410"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="08" codeSystem="2.16.840.1.113883.12.292"/>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>
    </section></component>
    <component><section>
      <code code="10160-0" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Medications</title>
      <entry><substanceAdministration classCode="SBADM" moodCode="EVN">
        <effectiveTime type="IVL_TS"><low value="20240101"/></effectiveTime>
        <effectiveTime type="PIVL_TS" operator="A"><period value="24" unit="h"/></effectiveTime>
        <doseQuantity value="10" unit="mg"/>
        <consumable><manufacturedProduct><manufacturedMaterial>
          <code code="83367" codeSystem="2.16.840.1.113883.6.88" displayName="Atorvastatin"/>
          <name>Atorvastatin 10 mg tablet</name>
        </manufacturedMaterial></manufacturedProduct></consumable>
      </substanceAdministration></entry>
    </section></component>
    <component><section>
      <code code="11450-4" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Active Problems</title>
      <text><table><tbody><tr ID="p1name"><td>Asthma</td></tr></tbody></table></text>
      <entry><act classCode="ACT" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.3"/>
        <statusCode code="active"/>
        <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.4"/>
          <effectiveTime><low value="20190601"/></effectiveTime>
          <value xsi:type="CD" code="195967001" codeSystem="2.16.840.1.113883.6.96" displayName="Asthma">
            <translation code="J45.909" codeSystem="2.16.840.1.113883.6.90" displayName="Unspecified asthma"/>
          </value>
          <entryRelationship typeCode="REFR"><observation classCode="OBS" moodCode="EVN">
            <templateId root="2.16.840.1.113883.10.20.22.4.6"/>
            <value xsi:type="CD" code="55561003" displayName="Active"/>
          </observation></entryRelationship>
        </observation></entryRelationship>
      </act></entry>
    </section></component>
    <component><section>
      <code code="48765-2" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Allergies</title>
      <text><content ID="a1">Penicillin</content></text>
      <entry><act classCode="ACT" moodCode="EVN">
        <templateId root="2.16.840.1.113883.10.20.22.4.30"/>
        <statusCode code="active"/>
        <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
          <templateId root="2.16.840.1.113883.10.20.22.4.7"/>
          <effectiveTime><low value="20180101"/></effectiveTime>
          <value xsi:type="CD" code="416098002" codeSystem="2.16.840.1.113883.6.96" displayName="Drug allergy"/>
          <participant typeCode="CSM"><participantRole classCode="MANU"><playingEntity classCode="MMAT">
            <code code="7980" codeSystem="2.16.840.1.113883.6.88" displayName="Penicillin"/>
          </playingEntity></participantRole></participant>
          <entryRelationship typeCode="MFST"><observation classCode="OBS" moodCode="EVN">
            <value xsi:type="CD" code="247472004" codeSystem="2.16.840.1.113883.6.96" displayName="Hives"/>
          </observation></entryRelationship>
          <entryRelationship typeCode="SUBJ"><observation classCode="OBS" moodCode="EVN">
            <templateId root="2.16.840.1.113883.10.20.22.4.8"/>
            <value xsi:type="CD" code="6736007" codeSystem="2.16.840.1.113883.6.96" displayName="Moderate"/>
          </observation></entryRelationship>
        </observation></entryRelationship>
      </act></entry>
    </section></component>
    <component><section>
      <code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/>
      <title>Vital Signs</title>
      <entry><organizer classCode="CLUSTER" moodCode="EVN">
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="8480-6" codeSystem="2.16.840.1.113883.6.1" displayName="Systolic blood pressure"/>
          <effectiveTime value="20260601"/>
          <value type="PQ" value="128" unit="mm[Hg]"/>
        </observation></component>
        <component><observation classCode="OBS" moodCode="EVN">
          <code code="8462-4" codeSystem="2.16.840.1.113883.6.1" displayName="Diastolic blood pressure"/>
          <effectiveTime value="20260601"/>
          <value type="PQ" value="82" unit="mm[Hg]"/>
        </observation></component>
      </organizer></entry>
    </section></component>
  </structuredBody></component>
</ClinicalDocument>`;

async function ccdJourney(browser) {
  const { ctx, page } = await adminPage(browser);
  const ccdPath = path.join(SHOTS, "fixture-ccd.xml");
  fs.writeFileSync(ccdPath, CCD_FIXTURE);
  await visit(page, "/data", 1500);
  await page
    .getByRole("tab", { name: /File upload/i })
    .or(page.getByRole("link", { name: /File upload/i }))
    .or(page.getByRole("button", { name: /File upload/i }))
    .first()
    .click()
    .catch(() => log("ccd: File upload tab not found — trying inline form"));
  await page.waitForTimeout(1000);
  const input = page.getByTestId("medical-upload-input");
  if (!(await input.count())) {
    log("ccd: medical-upload-input not found — check shots");
    await shot(page, "ccd-no-input");
    return ctx.close();
  }
  await input.setInputFiles(ccdPath);
  await page.waitForTimeout(500);
  await page.getByTestId("medical-upload-submit").click();
  await page.waitForTimeout(1500);
  await shot(page, "ccd-uploaded");
  // The structured import runs server-side; the lab should surface on the
  // Results → Biomarkers list under its (synthetic) display name.
  await visit(page, "/results?tab=biomarkers", 1500);
  const landed = await checkVisible(
    page,
    () => page.getByText("Esoteric Marker XYZ"),
    "ccd: imported lab NOT on Results → Biomarkers — the structured import may have failed",
    15
  );
  await shot(page, "ccd-results-after");
  if (landed) log("ccd: structured import landed (lab visible on Results)");
  // The condition + allergy from the Problems/Allergies sections.
  await visit(page, "/records/problems/conditions", 1500);
  await visit(page, "/records/problems/allergies", 1500);
  await checkVisible(
    page,
    () => page.getByText("Asthma"),
    "ccd: imported condition NOT on Records → Problems",
    6
  );
  await checkVisible(
    page,
    () => page.getByText("Penicillin"),
    "ccd: imported allergy NOT on Records → Problems",
    6
  );
  await shot(page, "ccd-problems-after");
  // Bonus probes, non-fatal: immunization (CVX 08) + the imported medication.
  await visit(page, "/records/history/immunizations", 1500);
  await shot(page, "ccd-immunizations-after");
  await visit(page, "/medications", 1500);
  await shot(page, "ccd-medications-after");
  await ctx.close();
}

// ---------------------------------------------------------------------------
const journeys = {
  onboarding: onboardingJourney,
  invite: inviteJourney,
  pages: pagesJourney,
  workflows: workflowsJourney,
  live: liveWorkoutJourney,
  dismiss: dismissFindingJourney,
  dose: doseJourney,
  profiles: profilesJourney,
  upload: uploadJourney,
  ccd: ccdJourney,
};
const args = process.argv.slice(2);
const serve = args.includes("--serve");
// #1510: --baseline <dir of a prior run> diffs its metrics.json/taps.json.
const baselineIdx = args.indexOf("--baseline");
const baselineDir = baselineIdx >= 0 ? args[baselineIdx + 1] : null;
const picked = args.filter(
  // A journey name — and, when --baseline is present, not its value argument.
  (a, i) => journeys[a] && (baselineIdx < 0 || i !== baselineIdx + 1)
);
if (!picked.length) {
  console.error(
    `usage: node scripts/ux-walkthrough.mjs [--serve] [--baseline <prior shots dir>] <journey...>\njourneys: ${Object.keys(journeys).join(", ")}
--serve boots the dev server itself on a scratch DB (ALLOS_DB_PATH, default /tmp/ux-walkthrough.db; UX_SEED=1 seeds it first, UX_SEED=thin seeds then trims to the last ~7 days) and tears it down after.
--baseline diffs a prior run's metrics.json/taps.json (pages/workflows journeys write them) into audit.md.`
  );
  process.exit(1);
}

// --serve: own the server lifecycle — scratch-DB env, boot, poll ready, and
// tear down in finally. NEVER defaults to the real data/allos.db.
let server = null;
if (serve) {
  const dbPath = process.env.ALLOS_DB_PATH || "/tmp/ux-walkthrough.db";
  const port = new URL(BASE).port || "3111";
  const env = {
    ...process.env,
    ALLOS_DB_PATH: dbPath,
    ADMIN_USERNAME: ADMIN_USER,
    ADMIN_PASSWORD: ADMIN_PASS,
    EMAIL_TEST_CAPTURE: MAIL_FILE,
    PORT: port,
  };
  // Census data shapes: unset = fresh DB (empty states), `1` = the full seed
  // (~3 weeks of history), `thin` = seed then trim observations to the last ~7
  // days (#1544) — the week-old-phone shape where trailing 7/30/90-day windows
  // coincide, which neither pole reproduces.
  if (process.env.UX_SEED === "1" || process.env.UX_SEED === "thin") {
    log("seeding scratch DB…");
    const r = spawnSync("npx", ["tsx", "scripts/seed.ts"], {
      env,
      stdio: "inherit",
    });
    if (r.status !== 0)
      log("WARNING: seed exited non-zero — continuing unseeded");
    if (process.env.UX_SEED === "thin") {
      log("thinning scratch DB to the last ~7 days…");
      const t = spawnSync("npx", ["tsx", "scripts/ux-thin-data.ts"], {
        env,
        stdio: "inherit",
      });
      if (t.status !== 0)
        log(
          "WARNING: thin trim exited non-zero — this run is the FULL seed shape, not thin"
        );
    }
  }
  log(`starting dev server on :${port} (db: ${dbPath})…`);
  server = spawn("npm", ["run", "dev"], {
    env,
    stdio: "ignore",
    detached: true,
  });
  let ready = false;
  // First compile can take minutes on a slow filesystem — poll patiently.
  for (let i = 0; i < 120 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    ready = await fetch(`${BASE}/login`)
      .then((r) => r.status === 200)
      .catch(() => false);
  }
  if (!ready) {
    try {
      process.kill(-server.pid);
    } catch {}
    throw new Error("--serve: dev server never became ready");
  }
  log("server ready");
}

const browser = await chromium.launch({
  executablePath: process.env.UX_CHROMIUM || undefined,
});
try {
  for (const name of picked) {
    log(`— journey: ${name} —`);
    await journeys[name](browser);
  }
} finally {
  await browser.close();
  writeContactSheet();
  writeAuditArtifacts(baselineDir);
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {}
    log("dev server stopped");
  }
}
log("screenshots in", SHOTS);
