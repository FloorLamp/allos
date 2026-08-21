import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { followLink, hydratedClick, spendAutoReloadRation } from "./helpers";
import {
  UPDATE_PENDING_KEY,
  UPDATE_PENDING_MARKER,
  UPDATE_TAKEN_KEY,
  UPDATE_TAKEN_MESSAGE,
} from "@/lib/sw-update";

// ONE notice per deploy (#1795), now on the OTHER side of the event (#2471), driven
// through the FALLBACK detector.
//
// WHAT CHANGED. Until #2471 a deploy asked before it did anything: a bar, a tap, a
// reload. The ruling is that the tab should schedule that itself, so the ordinary
// answer to a deploy is now — reload at the first provably-safe moment, then say so
// once. The bar survives only as the rationed-failure fallback: the automatic attempt
// has been spent and the tab is still stale, or work on screen would not survive a
// reload. Both halves are driven here, and the split is deliberate: the first two
// tests take the automatic path, the last two spend the ration first and assert the
// old contract, unchanged, in the state that still reaches it.
//
// WHY THE FALLBACK PATH (no worker) IS THE ONE TESTED HERE. The worker path has its
// end-to-end drive in e2e/sw-update.spec.ts. The half that had no coverage is the
// context with no worker at all — private mode, an unsupported browser, a failed
// registration — where the sha poll IS the detector and must feed the SAME one
// notice rather than a second one. `serviceWorkers: "block"` is that context exactly.
//
// Fixture discipline (#868): this spec WRITES NOTHING. It intercepts the version
// endpoint in its own page context (page.route is per-page, so no other spec sees
// it) and asserts on chrome the shared seed doesn't own.

test.use({ serviceWorkers: "block" });

// A commit that can never be the running build's (the app resolves a real 7-char git
// sha), so the fallback detector always reads it as a new deploy.
const DEPLOYED = { sha: "1795abc", commitMessage: "e2e deploy notice" };

// Debounced draft writes, a document load and the detector's own read have no single
// UI settle point between them. Named ceiling per the e2e-hygiene census.
const UPDATE_SETTLE_MS = 20_000;

async function interceptVersion(page: Page) {
  await page.route("**/api/version", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEPLOYED),
    })
  );
}

// The deploy, answered ONCE. The automatic path reloads the tab, and the reloaded
// document must read the sha it was actually served with — the way a tab that took a
// real update does — or it would keep finding the same simulated deploy forever.
// Counting the armed answers rather than disarming on a navigation event is what
// makes that deterministic: the detector reads once on mount and then latches
// (`finalRef`) on the mismatch it finds, so exactly one armed answer is one deploy.
async function interceptVersionOnce(page: Page) {
  let served = 0;
  await page.route("**/api/version", (route) => {
    if (served > 0) return route.continue();
    served += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(DEPLOYED),
    });
  });
}

/** Count document loads in the page itself, so "reloaded once" is measurable. */
async function countLoads(page: Page) {
  await page.addInitScript(() => {
    const n = Number(sessionStorage.getItem("updateSpecLoads") ?? "0");
    sessionStorage.setItem("updateSpecLoads", String(n + 1));
  });
}

async function loads(page: Page): Promise<string | null> {
  try {
    return await page.evaluate(() => sessionStorage.getItem("updateSpecLoads"));
  } catch {
    return null; // mid-navigation: the execution context is being replaced
  }
}

// The detector checks on its 60s interval AND whenever the tab becomes visible — the
// second is the hook a test can pull. Dispatching before the effect's listener is
// attached does nothing, so re-dispatch until the bar lands; the detector settles
// after the first mismatch, so extra dispatches are no-ops.
async function provokeVersionCheck(page: Page) {
  await expect(async () => {
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange"))
    );
    await expect(page.getByTestId("update-ready-bar")).toBeVisible({
      timeout: 1500,
    });
  }).toPass({ timeout: 25_000, intervals: [300, 700, 1500] }); // topass-ok: re-dispatches the visibility check past the hydration window — the listener only exists once the registrar's effect has settled, and there is no POST or navigation to settle on

  return page.getByTestId("update-ready-bar");
}

test("a clean tab takes the deploy by itself and says so afterwards (#2471)", async ({
  page,
}) => {
  test.slow();
  await countLoads(page);
  await interceptVersionOnce(page);

  // Nothing is typed, nothing is in flight, and nobody is touching the page — which
  // is the whole of what "the first safe moment" means for a clean tab.
  await page.goto("/equipment");

  // No consent bar, ever: the tab converges instead of asking.
  await expect
    .poll(() => loads(page), {
      timeout: UPDATE_SETTLE_MS,
      message: "the tab to reload itself onto the new build",
    })
    .toBe("2");

  // The notice inverts: tell-after, not ask-before — and it names what shipped.
  const toast = page.getByTestId("toast");
  await expect(toast).toContainText(UPDATE_TAKEN_MESSAGE, {
    timeout: UPDATE_SETTLE_MS,
  });
  await expect(toast).toContainText(DEPLOYED.commitMessage);
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);

  // ONE notice per taken build, and the consumption IS the dedupe: the marker is
  // gone, so no later reload — a manual refresh, #2155's late controller swap —
  // can toast for the build this tab just took.
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), UPDATE_TAKEN_KEY)
  ).toBeNull();
  // ANY client-side navigation will do here — this case is about the taken-build
  // marker, not about which row was clicked. It uses a TOP-LEVEL row on purpose:
  // #3079 moved Timeline into the collapsed "Plan & review" group, and a spec that
  // has no opinion about nav shape should not have to expand a group to say so.
  await followLink(
    page,
    page.locator("aside nav").getByRole("link", { name: "Trends" }),
    /\/trends/
  );
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), UPDATE_TAKEN_KEY)
  ).toBeNull();
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
  // …and the tab did not reload a second time for the same build.
  expect(await loads(page)).toBe("2");
});

test("a tab that is never quiet is left alone until it is (#2471)", async ({
  page,
}) => {
  test.slow();
  await countLoads(page);
  await interceptVersionOnce(page);
  await page.goto("/equipment");

  // A reload mid-scroll or mid-typing is the disruption the old bar was protecting
  // against, and the quiet gate is what replaces it. Drive continuous input for
  // longer than the quiet window and the document must survive it — literally: if
  // the tab reloaded, this evaluate's execution context would be destroyed and the
  // call would reject rather than resolve.
  await expect(
    page.evaluate(async () => {
      (window as unknown as Record<string, unknown>).__survived = true;
      // 30 × 200ms = six seconds of continuous input, twice the quiet window. A
      // count rather than a clock read: the duration is the point, and the harness
      // freezes the page's clock anyway.
      for (let i = 0; i < 30; i += 1) {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "a", bubbles: true })
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return (window as unknown as Record<string, unknown>).__survived === true;
    })
  ).resolves.toBe(true);
  expect(await loads(page)).toBe("1");

  // The input stops, the tab goes quiet, and it converges on its own.
  await expect
    .poll(() => loads(page), {
      timeout: UPDATE_SETTLE_MS,
      message: "the tab to reload once the page went quiet",
    })
    .toBe("2");
  await expect(page.getByTestId("toast")).toContainText(UPDATE_TAKEN_MESSAGE, {
    timeout: UPDATE_SETTLE_MS,
  });
});

test("with the automatic attempt spent, the deploy raises exactly one bar and it names the build (#1795)", async ({
  page,
}) => {
  // THE FALLBACK CONTRACT. A broken deploy — one the automatic reload has already
  // tried and failed to land — degrades to the affordance that shipped before #2471,
  // never to a reload loop. Spending the ration up front is that state.
  await spendAutoReloadRation(page);
  await interceptVersion(page);
  await page.goto("/equipment");

  const bar = await provokeVersionCheck(page);

  // ONE notice — not the bar plus a banner, which is what a single deploy used to
  // produce when two detectors owned two surfaces.
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(1);
  await expect(page.getByTestId("toast")).toHaveCount(0);

  // It carries the bar's posture (#1700) and the banner's one genuinely better
  // detail: what was deployed.
  await expect(bar).toContainText("Update ready");
  await expect(bar.getByTestId("update-ready-commit")).toHaveText(
    DEPLOYED.commitMessage
  );

  // It survives client-side navigation: the notice lives in the root layout, so it
  // rides along instead of being re-prompted per page.
  // A top-level row (see the note on the first case): the bar's survival across a
  // client navigation is the subject, not the nav registry.
  await followLink(
    page,
    page.locator("aside nav").getByRole("link", { name: "Trends" }),
    /\/trends/
  );
  await expect(bar).toBeVisible();
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(1);

  // Dismissible, and it stays dismissed across navigation. The bar is an offer again
  // in exactly this state, and an undismissable permanent bar on a deploy that keeps
  // failing would be worse than the thing #2471 replaced.
  await bar.getByTestId("update-ready-dismiss").click();
  await expect(bar).toHaveCount(0);
  await followLink(
    page,
    page.locator("aside nav").getByRole("link", { name: "Nutrition" }),
    /\/nutrition/
  );
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
});

test("the pending update is recorded where the crash boundary can read it (#1906)", async ({
  page,
}) => {
  // THE CONTRACT THIS PINS. A tab with a pending update is running a build whose
  // hashed chunks the deploy has removed, so a client navigation to a route it has
  // not visited can throw ABOVE the route group — and app/global-error.tsx replaces
  // the root layout, so ServiceWorkerRegister is not mounted when that boundary has
  // to tell deployment skew from an ordinary crash. A per-tab marker is the only
  // channel that survives; this asserts the registrar actually writes it, and clears
  // it, so the boundary's decision is fed by the real pending state rather than by a
  // key nobody sets. Driven with the ration spent, because that is the tab that
  // stays stale long enough for any of this to matter.
  await spendAutoReloadRation(page);
  await page.goto("/equipment");

  // Before any deploy: no marker, so the boundary would render its card.
  await expect
    .poll(() =>
      page.evaluate((k) => sessionStorage.getItem(k), UPDATE_PENDING_KEY)
    )
    .toBeNull();

  await interceptVersion(page);
  await provokeVersionCheck(page);

  await expect
    .poll(() =>
      page.evaluate((k) => sessionStorage.getItem(k), UPDATE_PENDING_KEY)
    )
    .toBe(UPDATE_PENDING_MARKER);

  // Dismissing the bar hides the OFFER but does not un-deploy anything: the tab is
  // still on the old build, so the marker must stay. This is the case a naive
  // "clear it when the bar goes away" would get wrong, and it is exactly the tab
  // that goes on to hit a missing chunk.
  await page
    .getByTestId("update-ready-bar")
    .getByTestId("update-ready-dismiss")
    .click();
  await expect(page.getByTestId("update-ready-bar")).toHaveCount(0);
  expect(
    await page.evaluate((k) => sessionStorage.getItem(k), UPDATE_PENDING_KEY)
  ).toBe(UPDATE_PENDING_MARKER);
});

// ── The two things that must not be crossed (#3371 fix round) ────────────────
//
// Both tests below are here rather than in e2e/form-drafts.spec.ts because the
// subject is the AUTOMATIC RELOAD, and this is the file that can make one happen: no
// worker, the sha poll as the detector, and the ration left unspent so the tab is
// genuinely free to converge. Neither writes a row.
//
// WHY THEY EXIST AT ALL. The gate they pin had no test at any tier when it shipped:
// `vitest.config.ts` includes `lib/**/*.test.ts` only, so `components/**` has no unit
// tier, and every other spec that touches this machinery calls `spendAutoReloadRation`
// to disable the automatic path so it can drive the manual one. Deleting the gate left
// lint, typecheck and the whole pure suite green.
//
// WHAT EACH ONE ACTUALLY CATCHES, mutation-measured 2026-08-21 rather than asserted:
//
//   * `pageDeclaresUnrecoverableWork()` removed from `useAutoUpdateReload` (both OR
//     sites and the import — exactly the deletion that used to pass every gate):
//     the FIRST test reds, `update-ready-bar` never appears because the tab
//     converges over the dialog instead of holding for it.
//   * `markUnsavedWork` moved back behind the 600ms debounce (reachable only from
//     `useFormDraft`'s `write`, i.e. the tree as #3371 first shipped it): the SECOND
//     test reds, and reds on the drafts store being empty 20s after the reload.
//
// AND WHAT THEY DO NOT CATCH, said here so nobody reads a green suite as more than it
// is: the post-await re-check inside `takeUpdate` is a strictly narrower race guard
// and no spec here distinguishes it. Its own comment says so at the site.

/** Every draft row in the browser's allos-offline store whose key names `formKey`. */
async function draftsFor(page: Page, formKey: string): Promise<string[]> {
  return page.evaluate(
    (fragment) =>
      new Promise<string[]>((resolve) => {
        const req = indexedDB.open("allos-offline");
        req.onerror = () => resolve([]);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("drafts")) {
            db.close();
            resolve([]);
            return;
          }
          const all = db
            .transaction("drafts", "readonly")
            .objectStore("drafts")
            .getAll();
          all.onerror = () => {
            db.close();
            resolve([]);
            return;
          };
          all.onsuccess = () => {
            const rows = (all.result ?? [])
              .filter((r: { key: string }) => String(r.key).includes(fragment))
              .map((r: unknown) => JSON.stringify(r));
            db.close();
            resolve(rows);
          };
        };
      }),
    `:${formKey}:`
  );
}

test("a hand-composed dialog holds the tab against an automatic reload (#3371)", async ({
  page,
}) => {
  test.slow();
  // THE DECLARATION AXIS OF THE RELOAD GATE, end to end. `markUnrecoverableWork` only
  // ever hears about forms the #1878 registry can SEE — named controls inside a
  // <form> — and a form that answers for itself with `data-unsaved` is by definition
  // one it cannot. The sleep dialog is not a <form> at all and keeps its content
  // nowhere but the DOM, so before #3371 an automatic update reload crossed it and
  // took the rating with it.
  //
  // THE RATION IS DELIBERATELY NOT SPENT. That matters for what this test can prove:
  // `autoReloadPlan` holds for exactly two reasons, ration-spent and
  // unrecoverable-work, and the bar renders only on a hold. With the ration unspent
  // the ONLY hold available is the one this issue added, so the bar's presence names
  // its own cause and cannot be produced by anything else on this page.
  await countLoads(page);
  await interceptVersionOnce(page);
  await page.goto("/sleep");

  await page.getByTestId("sleep-add-entry-header").click();
  const dialog = page.getByTestId("sleep-mood-edit-dialog");
  await expect(dialog).toBeVisible();
  // THE DIALOG'S OWN ANSWER FIRST, so a broken marker reds here and not as "the
  // reload gate regressed" twenty lines down.
  await expect(dialog).toHaveAttribute("data-unsaved", "false");
  await dialog.getByTestId("sleep-fact-mood").click();
  await dialog.getByTestId("sleep-history-mood-5").click();
  await dialog.getByTestId("sleep-editor-done").click();
  await expect(dialog).toHaveAttribute("data-unsaved", "true");

  const bar = await provokeVersionCheck(page);
  await expect(bar).toBeVisible();
  // And the tab did NOT converge underneath the dialog. Asserted after the bar is up,
  // so this is a statement about a decision that has already been made rather than a
  // race against one that has not.
  expect(await loads(page)).toBe("1");
  await expect(dialog).toBeVisible();

  // THE CONTROL, AND IT IS WHAT MAKES THE ASSERTION ABOVE NAME ITS OWN CAUSE. A bar
  // is evidence of a HOLD, not of WHICH hold — so take the declaration away and
  // nothing else, on the same page, under the same pending deploy, and the tab must
  // converge. Closing is the honest way to remove it: the Close button is the one
  // dismissal #3420 deliberately left unguarded, so this needs no confirm and the
  // dialog's state goes with it.
  // The Close control belongs to the HOST, not to the dialog body this testid names.
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(() => loads(page), {
      timeout: UPDATE_SETTLE_MS,
      message:
        "the tab to converge once the declaration is gone — if it never does, the bar above was not caused by the declaration",
    })
    .toBe("2");
});

test("a keystroke inside the autosave debounce is flushed, not crossed (#3371)", async ({
  page,
}) => {
  test.slow();
  // THE HOLE THIS ROUND CLOSED, driven at the only moment it exists.
  //
  // A draft-backed form is EXCLUDED from the declaration gate above, on the stated
  // grounds that the reload flushes it. That was false for the first 600ms after every
  // keystroke: `markUnsavedWork` was reached only from the post-debounce `write()`, so
  // a just-typed form sat in NO registry — `captureUnsavedWork()` answered
  // `{ ok: true }` over an empty drafts store and the reload took the typing.
  //
  // AND IT NEEDS NO WAITING TO REACH. `autoReloadPlan` short-circuits on a hidden tab
  // (`lib/sw-update.ts`, pinned in lib/__tests__/auto-reload.test.ts), skipping
  // INPUT_QUIET_MS entirely — so switching tabs within 600ms of a keystroke is the
  // whole reproduction. That is what the evaluate below performs, in one page task so
  // no round trip can drift out of the window.
  await countLoads(page);
  await interceptVersionOnce(page);
  // TWO INIT SCRIPTS THAT TOGETHER MAKE THE MOMENT REACHABLE ON PURPOSE.
  //
  // (1) A visibility flag the test can flip. `visibilityState` is a getter, so it is
  //     redefined rather than assigned, and it starts VISIBLE — a tab hidden from the
  //     first paint would take the deploy before this spec could open a form at all.
  // (2) An input heartbeat. While the tab is visible, `autoReloadPlan` needs
  //     INPUT_QUIET_MS of silence, so a page that is never quiet can never converge —
  //     that contract has its own test above. Holding the tab there is what makes the
  //     hidden flip below the ONLY reason it reloads, rather than a coincidence of
  //     timing with the quiet window.
  await page.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (hidden ? "hidden" : "visible"),
    });
    (window as unknown as Record<string, unknown>).__goHidden = () => {
      hidden = true;
    };
    setInterval(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Shift", bubbles: true })
      );
    }, 800);
  });

  await page.goto("/training?tab=routines");
  await expect(page.getByTestId("routines-section")).toBeVisible();
  // `hydratedClick`: this follows a fresh goto onto a route that rewrites its own URL
  // at hydration, and a click swallowed inside that window leaves the builder closed.
  await hydratedClick(page, page.getByTestId("routine-new"));
  const builder = page.getByTestId("routine-builder");
  await expect(builder).toBeVisible();
  await expect(builder).toHaveAttribute("data-unsaved", "false");
  // The tab has been sitting on a pending deploy this whole time and has not taken it,
  // because it is never quiet. That is the precondition for what follows.
  expect(await loads(page)).toBe("1");

  const ROUTINE = "Debounce Window Split";
  const probe = await page.evaluate(async (value) => {
    const form = document.querySelector<HTMLElement>(
      '[data-testid="routine-builder"]'
    );
    const field = document.querySelector<HTMLInputElement>(
      '[data-testid="routine-name"]'
    );
    if (!form || !field) return null;

    // A keystroke the way the browser delivers one, so React's onChange runs and the
    // draft hook's own `input` listener on the <form> fires synchronously.
    const started = performance.now(); // clock-ok: a duration inside one page task, not a wall-clock read
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));

    // Wait for the form to SAY it is dirty rather than for a fixed number of frames.
    // This routine is authored entirely in React state, so the honest signal is the
    // marker landing after React commits — and the marker is written by the very
    // call that registers the flush, which is what makes it the right thing to wait
    // for here.
    const deadline = 400;
    while (
      form.getAttribute("data-unsaved") !== "true" &&
      performance.now() - started < deadline // clock-ok: same duration
    ) {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    const markedAt = performance.now() - started; // clock-ok: same duration

    // THE PRECONDITION, PROVEN RATHER THAN ASSUMED: nothing is durable yet. If the
    // debounce had already fired this test would be exercising the safe path and
    // passing for the wrong reason, so it reports the fact instead of hoping.
    const draftsBefore = await new Promise<number>((resolve) => {
      const req = indexedDB.open("allos-offline");
      req.onerror = () => resolve(-1);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("drafts")) {
          db.close();
          resolve(0);
          return;
        }
        const all = db
          .transaction("drafts", "readonly")
          .objectStore("drafts")
          .getAll();
        all.onerror = () => {
          db.close();
          resolve(-1);
        };
        all.onsuccess = () => {
          const n = (all.result ?? []).filter((r: { key: string }) =>
            String(r.key).includes(":routine:")
          ).length;
          db.close();
          resolve(n);
        };
      };
    });

    // THE FLIP. Hidden short-circuits `autoReloadPlan` past the quiet window, so this
    // is the tab-switch or screen-lock that reproduces the hazard, taken inside the
    // debounce and in the same page task as the keystroke.
    const flippedAt = performance.now() - started; // clock-ok: same duration
    (window as unknown as { __goHidden: () => void }).__goHidden();
    document.dispatchEvent(new Event("visibilitychange"));
    return { markedAt, flippedAt, draftsBefore };
  }, ROUTINE);

  expect(probe, "the routine builder to be on screen").not.toBeNull();
  // NON-VACUITY, both halves, and the messages say which failed: this test is only
  // about the debounce window, and it must never pass by having missed it.
  expect(
    probe!.flippedAt,
    "the tab must go hidden INSIDE the 600ms autosave debounce — outside it, the draft is already durable and this test proves nothing"
  ).toBeLessThan(600);
  expect(
    probe!.draftsBefore,
    "no routine draft may be durable yet at the moment the tab goes hidden — that is the whole hazard"
  ).toBe(0);

  // The tab is free to converge, and it should: draft-backed work is meant to be
  // FLUSHED rather than to block a deploy. What must not happen is converging over
  // typing that was never written down.
  await expect
    .poll(() => loads(page), {
      timeout: UPDATE_SETTLE_MS,
      message: "the hidden tab to take the deploy",
    })
    .toBe("2");

  // A PRESENCE assertion on the far side, which is the honest shape here: no ceiling
  // can conjure a draft that was never written.
  await expect
    .poll(async () => (await draftsFor(page, "routine")).join(""), {
      timeout: UPDATE_SETTLE_MS,
      message: "the typing to be durable on the other side of the reload",
    })
    .toContain(ROUTINE);

  // ── AND THE USER-FACING HALF OF THE SAME FACT ─────────────────────────────
  //
  // MUTATION-MEASURED, 2026-08-21, both halves of this test against the registration
  // moved back behind the debounce (`markUnsavedWork` reachable only from `write`,
  // which is the tree as #3371 first shipped it):
  //
  //   * the drafts poll above went RED, `""` after the full 20s ceiling — the reload
  //     crossed the keystroke and NOTHING was ever written. It is the verdict, not
  //     scenery: the reload's own fallback does not outlast a debounce that the
  //     navigation cancels.
  //   * so the pair below never got to run under the mutant. It is asserted anyway,
  //     because it is the shape a user meets, and because it fails on a DIFFERENT
  //     mechanism — whether `captureUnsavedWork()` had a registered entry to take a
  //     resume pointer FROM. `takeUpdate` writes RESUME_EDITOR_KEY only when one came
  //     back and REMOVES it otherwise, so the two worlds diverge into the next
  //     document and stay diverged:
  //
  //       registered   → marker written → the draft auto-applies, no banner
  //       unregistered → marker removed → today's offer banner, an empty field
  await expect(page.getByTestId("routines-section")).toBeVisible();
  await hydratedClick(page, page.getByTestId("routine-new"));
  const reopened = page.getByTestId("routine-builder");
  await expect(reopened).toBeVisible();
  await expect(
    reopened.getByTestId("routine-name"),
    "the editor must come back carrying the typing — a reload that flushed nothing leaves this empty behind a restore banner"
  ).toHaveValue(ROUTINE);
  await expect(
    reopened.getByTestId("draft-restore-banner"),
    "the continuation is the tap that already happened (#2471): a banner here means the reload crossed the typing and is asking the user to recover it"
  ).toHaveCount(0);
});
