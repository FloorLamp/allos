// Which Chromium binary browser tooling launches (issues #3816 and #4008).
//
// CI installs only the headless shell, while managed development environments
// may carry both that shell and full Chromium under PLAYWRIGHT_BROWSERS_PATH.
// Playwright tests prefer the shell for CI parity. Visual walkthroughs require
// full Chromium, and may name an explicit executable with UX_CHROMIUM.

import fs from "node:fs";

const CHROMIUM_BUILDS = [
  ["chromium_headless_shell-", "chrome-linux/headless_shell"],
  ["chromium-", "chrome-linux/chrome"],
];

/**
 * Resolve a Chromium executable, or leave resolution to Playwright.
 *
 * @param {{
 *   executableOverride?: string,
 *   browsersPath?: string,
 *   allowHeadlessShell?: boolean,
 * }} [options]
 * @returns {string | undefined}
 */
export function resolveChromiumExecutable({
  executableOverride,
  browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH,
  allowHeadlessShell = true,
} = {}) {
  if (executableOverride) return executableOverride;
  if (!browsersPath || !fs.existsSync(browsersPath)) return undefined;

  const entries = fs.readdirSync(browsersPath);
  const builds = allowHeadlessShell
    ? CHROMIUM_BUILDS
    : CHROMIUM_BUILDS.slice(1);
  for (const [prefix, executable] of builds) {
    const dir = entries
      .filter((entry) => entry.startsWith(prefix))
      .sort((a, b) => {
        const aRevision = Number(a.slice(prefix.length));
        const bRevision = Number(b.slice(prefix.length));
        return aRevision - bRevision;
      })
      .at(-1);
    if (!dir) continue;
    const path = `${browsersPath}/${dir}/${executable}`;
    if (fs.existsSync(path)) return path;
  }
  return undefined;
}
