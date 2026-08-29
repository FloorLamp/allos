// Which Chromium binary the e2e suite launches (issue #4008).
//
// CI installs `--only-shell chromium` (.github/actions/e2e-setup), so its runner
// carries exactly ONE binary: `chromium_headless_shell`. A managed dev environment
// points PLAYWRIGHT_BROWSERS_PATH at a pre-installed set that carries BOTH, at a
// revision Playwright's own resolver will not accept (it pins one exact revision
// per version), so playwright.config.ts has to name the executable itself. It named
// the FULL Chromium — so a local `--repeat-each=3 --retries=0` run was parity for
// timing, ordering and sharding, and parity for no browser COMPONENT at all: the
// PDF viewer, print preview, media codecs are in one binary and not the other.
//
// That gap is not cosmetic. #3975 measured a security assertion about framing a
// stored PDF that was byte-identical whether the policy PERMITTED or FORBADE the
// frame, because the shell has no PDF viewer: it diverts the response to the
// download path before the frame commits, and `frame-ancestors` is evaluated at
// commit. The assertion could not have gone red on CI. Passing locally said nothing.
//
// So the shell is preferred wherever one is installed, and the full build is only
// the fallback for an environment that has no shell. Pure and fs-only so
// lib/__tests__/e2e-chromium.test.ts can drive it against real directory layouts.

import fs from "node:fs";

/**
 * Directory prefix and the executable inside it, MOST PREFERRED FIRST.
 *
 * The prefixes do not overlap: Playwright names the shell's directory
 * `chromium_headless_shell-<rev>`, which `chromium-` does not match.
 */
const CHROMIUM_BUILDS = [
  ["chromium_headless_shell-", "chrome-linux/headless_shell"],
  ["chromium-", "chrome-linux/chrome"],
] as const;

/**
 * The pre-installed Chromium to launch, or `undefined` when the environment has
 * none and Playwright should resolve its own managed browser (that is CI).
 */
export function preinstalledChromium(
  base = process.env.PLAYWRIGHT_BROWSERS_PATH
): string | undefined {
  if (!base || !fs.existsSync(base)) return undefined;
  const entries = fs.readdirSync(base);
  for (const [prefix, executable] of CHROMIUM_BUILDS) {
    const dir = entries
      .filter((entry) => entry.startsWith(prefix))
      .sort()
      .at(-1);
    if (!dir) continue;
    const exe = `${base}/${dir}/${executable}`;
    if (fs.existsSync(exe)) return exe;
  }
  return undefined;
}
