import { expect, type Locator, type Page } from "@playwright/test";
import type { Access } from "../lib/grants";
import { settledCheck, settledClick, settledFill } from "./helpers";

// Shared drivers for the Settings → Family screen (issue #868, phase-2 create-member
// hardening). Family create/grant buttons are NOT native form submits — each is an
// `onClick` handler that runs a Server Action and then `router.refresh()`es the RSC
// tree (see app/(app)/settings/family/FamilyManager.tsx). Two failure modes fall out
// of that shape, and they are why every dynamic family spec had grown its own copy of
// the same fragile goto→fill→click→verify dance (~9 copies before this module):
//
//   1. A click dispatched in the hydration window is SWALLOWED — the onClick isn't
//      wired yet, so NO create POST fires at all and the spec sits waiting on a row
//      that will never appear (#730/#830).
//   2. The settings shell's background toasters poll via Server Action POSTs to the
//      CURRENT route, indistinguishable from the create action's own POST — so a
//      bare settledClick can FALSE-SETTLE on a bystander poll while the create never
//      landed (the profile-switch-toasts precedent), and a `router.refresh()` under
//      CI load can leave a STALE matrix that never shows the new row.
//
// The proven fix (surviving the retries=0 census in two-factor / view-only-access /
// wellbeing-check) is to retry the WHOLE goto→fill→click cycle against the DURABLE
// server-rendered row, re-`goto`ing each attempt so a stale RSC can't wedge it. That
// retry is idempotent by construction (a login's NOCASE-unique username rejects a
// duplicate submit while the fresh goto still finds the first attempt's row; a
// profile create is VERIFY-FIRST so an un-unique name can't be added twice). This
// module is the ONE home for that pattern; the hygiene guard
// (lib/__tests__/e2e-hygiene.test.ts) freezes the inline create/grant sequences per
// file so the duplication can't regrow, and a NEW inline one fails CI.

// Per-worker monotonic counter so two create calls in the same millisecond can't
// collide on Date.now() alone (profile names are NOT unique-constrained).
let familySeq = 0;

// A member password that clears the strength gate and embeds no username.
const MEMBER_PASSWORD = "member-pass-1234";

export interface Credentials {
  username: string;
  password: string;
}

export interface CreateLoginOpts {
  // Defaults to a unique-per-run username (so a retry against the persistent DB
  // can't collide on the NOCASE-unique username).
  username?: string;
  password?: string;
  email?: string;
  role?: "admin" | "member";
  // Email an invite instead of setting the password out-of-band. Requires `email`
  // and a mail-configured instance (the create-invite checkbox only renders then).
  invite?: boolean;
}

// The universal "did the login land" signal: every login (admin OR member) renders a
// `login-row` carrying its username as exact text. A member ALSO gets a
// `grant-row-<username>`, but an admin does not — so the login-row is the one durable
// row that works for both, and the create loop settles on it. The `exact`-text filter
// avoids a substring collision between per-run-unique usernames.
function loginRowFor(page: Page, username: string): Locator {
  return page
    .getByTestId("login-row")
    .filter({ has: page.getByText(username, { exact: true }) });
}

// Create a login through Settings → Family, hardened against the create-click
// hydration swallow + the toaster-poll false-settle (#830/#1111). Returns the
// credentials so the caller can sign in as the new login in a fresh context.
//
// settledFill on the username waits for the LoginsCard to hydrate BEFORE we touch the
// controlled role select / invite checkbox (a pre-hydration toggle would revert and
// silently create the login with the WRONG role/invite); once the username lands in
// state the whole card is hydrated, so the remaining plain fills/toggles stick. The
// outer goto-retry then absorbs a swallowed click or a stale post-refresh matrix.
export async function createLoginViaFamily(
  page: Page,
  opts: CreateLoginOpts = {}
): Promise<Credentials> {
  const role = opts.role ?? "member";
  const username = opts.username ?? `${role}-${Date.now()}-${++familySeq}`;
  const password = opts.password ?? MEMBER_PASSWORD;
  const row = loginRowFor(page, username);

  // The family create button is onClick+router.refresh() (not a form submit), so no
  // single awaitable event exists — re-goto→fill→click until the durable login-row
  // renders; idempotent via the NOCASE-unique username (#830/#1111).
  await expect(async () => {
    await page.goto("/settings/family");
    await settledFill(page, page.getByPlaceholder("Username"), username);
    await page.getByPlaceholder("Password").fill(password);
    if (opts.email !== undefined) {
      await page.getByPlaceholder("Email (optional)").fill(opts.email);
    }
    if (role !== "member") {
      await page.getByTestId("create-role").selectOption(role);
    }
    if (opts.invite) {
      // The invite checkbox is enabled only once a non-empty email is in state (filled
      // above); .check() throws if the click didn't stick, which fails the attempt and
      // re-drives the whole cycle — self-correcting, so no extra guard is needed.
      await page.getByTestId("create-invite").check();
    }
    await page.getByRole("button", { name: "Create login" }).click();
    await expect(row).toBeVisible({ timeout: 5000 });
    // The onClick+refresh create has no single awaitable event, so retry the whole
    // cycle against the durable login-row (idempotent via the NOCASE-unique username).
  }).toPass({ timeout: 45_000 }); // topass-ok: onClick+refresh create, no single awaitable event (#830)

  return { username, password };
}

// A profile ROW renders its name only in a rename `<input value={name}>` — the
// `getByText(name)` a naive create used to settle on is the TRANSIENT success banner
// (`Added profile "<name>"`), which a reload/goto wipes. The durable "did the create
// land" signal is a profile-row input carrying this exact value. `input:not([placeholder])`
// excludes the "Add a profile" field (placeholder "Name"); reading the value PROPERTY
// via evaluateAll (React doesn't reflect a controlled input's value to the DOM
// attribute) also sidesteps strict-mode without a first-match locator.
async function profileRowExists(page: Page, name: string): Promise<boolean> {
  return page
    .locator("div.card")
    .filter({ hasText: "Add a profile" })
    .locator("input:not([placeholder])")
    .evaluateAll(
      (els, n) => els.some((e) => (e as HTMLInputElement).value === n),
      name
    );
}

// Switch the shared session's active profile via the sidebar UserMenu, retry-clicking
// through the hydration window (#730) as the household/front-door specs do.
export async function switchToProfile(page: Page, name: string): Promise<void> {
  const target = page
    .getByTestId("user-menu-popover")
    .getByRole("button", { name });
  await expect(async () => {
    await page.getByTestId("user-menu-trigger").click();
    await expect(target).toBeVisible({ timeout: 2_000 });
    // The popover trigger can be clicked pre-hydration; no single awaitable event
    // covers "trigger opened AND target rendered", so re-open until it does.
  }).toPass(); // topass-ok: popover trigger pre-hydration re-open (#730)
  await target.click();
  await expect(page.getByTestId("user-menu-trigger")).toContainText(name);
}

// Create a fresh profile through Settings → Family, switch the active profile to it,
// and defer goal-based onboarding through the product's own affordance so the fresh
// profile lands on the dashboard. Returns the (unique) profile name. An admin can act
// as any profile, so the caller (running as admin) can then drive the new profile.
//
// The create loop is VERIFY-FIRST: profile names are NOT unique-constrained
// (createProfile does a bare INSERT), so a blind re-click after a landed-but-slow
// create would add a SECOND same-named profile. Re-reading the card before each click
// makes a retry a no-op once the row exists (the wellbeing-check precedent).
export async function createProfileViaFamily(
  page: Page,
  label: string
): Promise<string> {
  const name = `${label}-${Date.now()}-${++familySeq}`;
  // The Add button is onClick+router.refresh() (not a form submit) — no single awaitable
  // event exists; re-goto and re-check the durable profile row, clicking Add only when
  // it's absent so a landed-but-slow create never duplicates the un-unique name (#830).
  await expect(async () => {
    await page.goto("/settings/family");
    if (await profileRowExists(page, name)) return;
    const profilesCard = page
      .locator("div.card")
      .filter({ hasText: "Add a profile" });
    await profilesCard.getByPlaceholder("Name", { exact: true }).fill(name);
    await profilesCard
      .getByRole("button", { name: "Add", exact: true })
      .click();
    // Settle on the durable row, not the transient banner; give the action a moment
    // to land before forcing a full re-goto retry.
    await expect
      .poll(() => profileRowExists(page, name), { timeout: 8000 })
      .toBe(true);
    // The onClick+refresh create has no single awaitable event; VERIFY-FIRST re-goto
    // so a landed-but-slow create never dupes the un-unique name.
  }).toPass({ timeout: 45_000 }); // topass-ok: onClick+refresh create, verify-first re-goto (#830)

  await switchToProfile(page, name);
  await page.goto("/");
  if (page.url().includes("/onboarding")) {
    await page
      .getByRole("button", { name: "Set up later, take me to my dashboard" })
      .click();
    await expect(page).toHaveURL(/\/$|\/\?/);
  }
  return name;
}

// Grant `username` a profile at an access level via the grants matrix and confirm the
// save landed. Fresh-`goto`s so it never depends on a prior helper's ending page or a
// stale post-refresh matrix. The access select is disabled until the profile is
// checked, so we check first (settledCheck waits for hydration so the controlled
// checkbox's onChange fires), then set the level, then settledClick the save and
// assert the durable "Access updated." banner.
export async function setGrantsViaFamily(
  page: Page,
  username: string,
  grant: { profileId: number; access: Access }
): Promise<void> {
  await page.goto("/settings/family");
  const grantRow = page.getByTestId(`grant-row-${username}`);
  await expect(grantRow).toBeVisible();
  const cell = grantRow.getByTestId(
    `grant-cell-${username}-${grant.profileId}`
  );
  await settledCheck(page, cell.locator('input[type="checkbox"]'), true);
  await grantRow
    .getByTestId(`grant-access-${username}-${grant.profileId}`)
    .selectOption(grant.access);
  // settledClick + a widened banner timeout: the raw save click races the action's POST
  // under full-suite load, and "Access updated." renders only once the action lands;
  // settledClick can return on a toaster poll's POST while the save is still in flight,
  // so give the banner 15s rather than the 5s default (#830).
  await settledClick(
    page,
    grantRow.getByRole("button", { name: "Save access" })
  );
  await expect(grantRow.getByText("Access updated.")).toBeVisible({
    timeout: 15_000,
  });
}
