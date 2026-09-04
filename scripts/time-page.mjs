// Time a page's server response through a real browser session (#5010).
//
//   node scripts/time-page.mjs --base http://localhost:3000 --path / --runs 6
//
// Logs in through the login form (defaults to the `a` / `a` login the snapshot
// puller writes), then loads `--path` `--runs` times and prints the browser's
// time-to-first-byte, DOMContentLoaded and HTML size per run, plus the median.
// Against `next dev` the first run compiles the route; read the rest. A dev server's
// own log prints the `application-code:` split per request beside these numbers.
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean)
);
const base = args.base ?? "http://localhost:3000";
const target = args.path ?? "/";
const runs = Number(args.runs ?? 6);
const user = args.user ?? "a";
const pass = args.pass ?? "a";

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: {
    width: Number(args.width ?? 1280),
    height: Number(args.height ?? 900),
  },
});
const page = await context.newPage();
await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" });
await page.fill('input[name="username"]', user);
await page.fill('input[name="password"]', pass);
await Promise.all([
  page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60_000 }),
  page.click('button[type="submit"]'),
]);

const rows = [];
for (let run = 1; run <= runs; run += 1) {
  const response = await page.goto(base + target, { waitUntil: "load" });
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return {
      ttfb: n.responseStart - n.requestStart,
      dcl: n.domContentLoadedEventEnd - n.startTime,
    };
  });
  const html = (await response.text()).length;
  rows.push({
    run,
    status: response.status(),
    ttfb_ms: Math.round(nav.ttfb),
    dcl_ms: Math.round(nav.dcl),
    html_kb: Math.round(html / 1024),
  });
}
await browser.close();

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
console.table(rows);
console.log(
  `${target}: median TTFB ${Math.round(median(rows.map((r) => r.ttfb_ms)))} ms over ${runs} runs` +
    (runs > 1
      ? ` (${Math.round(median(rows.slice(1).map((r) => r.ttfb_ms)))} ms excluding the first)`
      : "")
);
