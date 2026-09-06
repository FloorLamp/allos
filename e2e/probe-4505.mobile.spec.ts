import { test } from "./fixtures";
import fs from "node:fs";

const ROUTES = [
  "/", "/nutrition", "/nutrition?tab=supplements", "/medications", "/settings/notifications",
  "/upcoming", "/training?tab=overview", "/results", "/sleep", "/records/history/visits",
  "/records/history/immunizations", "/records/problems/allergies", "/longevity",
  "/medical/episodes", "/medical/substance-use", "/providers", "/data", "/settings",
  "/history", "/training?tab=log", "/results/imaging", "/settings/notify-log",
];

test("probe", async ({ page }) => {
  test.setTimeout(600_000);
  const out: Record<string, unknown> = {};
  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForTimeout(2500);
    out[route] = await page.evaluate(() => {
      const read = (el: Element) => {
        const r = el.getBoundingClientRect();
        const after = getComputedStyle(el, "::after");
        return {
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute("data-testid"),
          cls: (el.getAttribute("class") ?? "").split(" ").filter(c => /fold-control|tap-target|min-h|^h-|py-/.test(c)).join(" "),
          text: (el.textContent ?? "").trim().slice(0, 30),
          h: Math.round(r.height * 100) / 100,
          w: Math.round(r.width * 100) / 100,
          reach: after.content === "none" ? 0 : Math.abs(parseFloat(after.top)),
          lh: parseFloat(getComputedStyle(el).lineHeight),
        };
      };
      const vis = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return {
        summaries: Array.from(document.querySelectorAll("summary")).filter(vis).map(read),
        taps: Array.from(document.querySelectorAll(".tap-target")).filter(vis).map(read),
      };
    });
  }
  fs.writeFileSync("/root/.local/state/allos-work/probe-pressable-families-4505.json", JSON.stringify(out, null, 1));
});
