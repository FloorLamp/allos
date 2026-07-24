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
// teardown; UX_SEED=1 seeds first for a data-rich census):
//
//   node scripts/ux-walkthrough.mjs --serve onboarding pages
//
// Journeys: `onboarding` (fresh-install wizard, admin), `invite` (email invite →
// set-password → member first sign-in), `pages` (screenshot every static
// app/(app) route at desktop AND mobile widths — the visual census), `workflows`
// (quick-log starter set: search, activity, check-in, food, weight, medication),
// `live` (live workout mode: start → set → finish → verify), `dismiss` (dismiss
// a finding, verify it stays dismissed across reload), `dose` (confirm a dose,
// verify persistence), `profiles` (switch acting profile + the read-only member
// experience), `upload` (medical document upload, offline path). Run
// `onboarding` first on a fresh DB — it saves the admin session the later
// journeys reuse. Every run writes an index.html contact sheet next to the
// shots.
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
  page.setDefaultTimeout(45_000);
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
  // Let the form hydrate — a pre-hydration submit is silently swallowed.
  await page.waitForTimeout(2000);
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page
    .waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 })
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
  page.setDefaultTimeout(45_000);

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
  page.setDefaultTimeout(45_000);
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
  inv.setDefaultTimeout(45_000);
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
// Journey: every static page, desktop + mobile. Routes are enumerated from the
// filesystem (app/(app)/**/page.tsx, dynamic [param] segments skipped), so the
// census stays current as pages are added. Redirect routes screenshot their
// target — that's fine, the point is "what does a user see at every URL".
async function pagesJourney(browser) {
  const appDir = path.join(process.cwd(), "app", "(app)");
  const routes = [];
  const walk = (dir, route) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) {
        if (e.name === "page.tsx") routes.push(route || "/");
        continue;
      }
      if (e.name.startsWith("[")) continue; // dynamic — needs an id, skip
      walk(path.join(dir, e.name), `${route}/${e.name}`);
    }
  };
  walk(appDir, "");
  log(`pages census: ${routes.length} static routes`);

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
    page.setDefaultTimeout(45_000);
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
    for (const route of routes.sort()) {
      const slug = route === "/" ? "home" : route.slice(1).replace(/\//g, "-");
      try {
        await page.goto(`${BASE}${route}`);
        await page.waitForTimeout(1200);
        await shot(page, `page-${tag}-${slug}`);
      } catch (err) {
        log(`FAILED to shoot ${route} (${tag}): ${err.message.split("\n")[0]}`);
      }
    }
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// Journey: common workflows — a starter set, each a short "do the thing a user
// does" sequence with shots before/after. Add more by following this shape;
// keep each step honest (log loudly when a step can't complete rather than
// silently skipping — this is a seeing tool, a blind spot must be visible).
async function workflowsJourney(browser) {
  const { ctx, page } = await adminPage(browser);

  // Workflow: global search (the palette deep-links everywhere).
  await page
    .getByRole("button", { name: /Search/ })
    .first()
    .click();
  await page.waitForTimeout(500);
  await page.keyboard.type("vitamin");
  await page.waitForTimeout(1200);
  await shot(page, "workflow-search-results");
  await page.keyboard.press("Escape");

  // Workflow: quick-log an activity (the sidebar's primary action).
  await page.getByRole("button", { name: "Log activity" }).first().click();
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
    await box.fill("Walking").catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, "workflow-log-activity-filled");
    // Scope to the editor — an unscoped role=option match hits the sidebar
    // calendar's native <select> options.
    const option = form.locator('[role="option"], [role="listbox"] li').first();
    if (await option.count()) await option.click();
    else await box.press("Enter");
    await page.waitForTimeout(800);
    // A cardio part needs a distance or duration before the draft saves
    // ("Not saved — Enter a distance, duration, or a start & end time").
    await form
      .getByTestId("cardio-duration")
      .fill("30")
      .catch(() => {});
    await page.waitForTimeout(800);
    await shot(page, "workflow-log-activity-committed");
    const done = page.getByRole("button", { name: "Done" });
    if (await done.count()) {
      await done.first().click();
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
      log("log-activity: no Done button found — left editor open (see shots)");
      await page.keyboard.press("Escape");
    }
  } else {
    log("log-activity: editor did not open — check shots");
  }

  // Workflow: daily check-in (tap a mood on the dashboard card).
  await page.goto(`${BASE}/`);
  await page.waitForTimeout(2000);
  const checkin = page.getByTestId("how-are-you-card");
  if (await checkin.count()) {
    await checkin.scrollIntoViewIfNeeded();
    await shot(page, "workflow-checkin-before");
    await checkin.getByTestId("mood-tap-4").click();
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
    await page.getByTestId("log-nuts_seeds").click();
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
    await weight.fill("82");
    await page.getByRole("button", { name: "Save entry" }).click();
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
    await medToggle.click();
    await page.waitForTimeout(800);
    const quick = page.getByTestId("quick-add-medication");
    if (await quick.count()) {
      await quick.getByPlaceholder(/Ibuprofen/).fill("Ibuprofen");
      await quick.getByTestId("quick-add-amount").fill("200 mg");
      await shot(page, "workflow-med-filled");
      await quick.getByRole("button", { name: "Quick add" }).click();
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
  const weight = page.getByTestId("set1-weight");
  if (await weight.count()) await weight.fill("60");
  await shot(page, "live-set-logged");
  await page
    .getByRole("button", { name: "+ Add set" })
    .click()
    .catch(() => log("live-workout: '+ Add set' not found"));
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
  await dismiss.click();
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
  await take.click();
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
  await page.getByTestId("user-menu-trigger").first().click();
  await page.waitForTimeout(600);
  await shot(page, "profiles-menu-open");
  const switchTo = page.getByTestId("switch-to-2");
  if (await switchTo.count()) {
    await switchTo.click();
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
    log("profile-switch: switch-to-2 not in the profile menu — check shots");
    await page.keyboard.press("Escape");
  }

  // -- Read-only member: set jordan's grant on profile 2 to read-only.
  await visit(page, "/settings/family", 1500);
  const cell = page.getByTestId("grant-cell-jordan-2");
  const level = cell.locator("select");
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
  member.setDefaultTimeout(45_000);
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
  await visit(page, "/settings/family", 1500);
  await page
    .getByTestId("grant-cell-jordan-2")
    .locator("select")
    .selectOption("write");
  await page.getByRole("button", { name: "Save access" }).click();
  await page.waitForTimeout(1200);
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
    .getByRole("tab", { name: /File Upload/ })
    .or(page.getByRole("link", { name: /File Upload/ }))
    .or(page.getByRole("button", { name: /File Upload/ }))
    .first()
    .click()
    .catch(() => log("upload: File Upload tab not found — trying inline form"));
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
  await page.getByRole("button", { name: "Upload" }).click();
  await checkVisible(
    page,
    () => page.getByText(/Upload received|fixture-upload/),
    "upload: no receipt message or document listing appeared — upload may have failed"
  );
  await shot(page, "upload-after");
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
};
const args = process.argv.slice(2);
const serve = args.includes("--serve");
const picked = args.filter((a) => journeys[a]);
if (!picked.length) {
  console.error(
    `usage: node scripts/ux-walkthrough.mjs [--serve] <journey...>\njourneys: ${Object.keys(journeys).join(", ")}
--serve boots the dev server itself on a scratch DB (ALLOS_DB_PATH, default /tmp/ux-walkthrough.db; UX_SEED=1 seeds it first) and tears it down after.`
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
  if (process.env.UX_SEED === "1") {
    log("seeding scratch DB…");
    const r = spawnSync("npx", ["tsx", "scripts/seed.ts"], {
      env,
      stdio: "inherit",
    });
    if (r.status !== 0)
      log("WARNING: seed exited non-zero — continuing unseeded");
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
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {}
    log("dev server stopped");
  }
}
log("screenshots in", SHOTS);
