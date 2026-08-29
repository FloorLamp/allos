import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { preinstalledChromium } from "../e2e-chromium";
import { makeTmpDir } from "./tmp-dir";

/** Lay down `<base>/<dir>/<exe>` the way `playwright install` does; bytes irrelevant. */
function build(base: string, dir: string, exe: string): string {
  const abs = path.join(base, dir, exe);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, "#!/bin/sh\n");
  return abs;
}

const SHELL = "chrome-linux/headless_shell";
const FULL = "chrome-linux/chrome";

// THE CLAIM: a local run launches the binary CI launches. CI installs
// `--only-shell chromium`, so the shell is the only build it has; a managed dev
// environment carries both, and preferring the full one there made every
// browser-component assertion non-parity while reporting none of it (#4008).
describe("the pre-installed Chromium the e2e suite launches", () => {
  it("prefers the headless shell when a browsers path carries both builds", () => {
    const base = makeTmpDir("pw-browsers");
    build(base, "chromium-1194", FULL);
    const shell = build(base, "chromium_headless_shell-1194", SHELL);
    expect(preinstalledChromium(base)).toBe(shell);
  });

  // Falling back is what keeps a shell-less environment working at all: Playwright
  // pins one exact revision per version, so it cannot adopt a pre-installed set of
  // its own and there would be no browser to launch.
  it.each([
    ["only the full build is installed", "chromium-1194", FULL],
    ["only the shell is installed", "chromium_headless_shell-1194", SHELL],
  ])("uses what is there when %s", (_case, dir, exe) => {
    const base = makeTmpDir("pw-browsers");
    const installed = build(base, dir, exe);
    expect(preinstalledChromium(base)).toBe(installed);
  });

  it("ignores a build directory with no executable, and a path that is not there", () => {
    const base = makeTmpDir("pw-browsers");
    fs.mkdirSync(path.join(base, "chromium_headless_shell-1194"));
    const full = build(base, "chromium-1194", FULL);
    expect(preinstalledChromium(base)).toBe(full);
    expect(preinstalledChromium(path.join(base, "absent"))).toBeUndefined();
    expect(preinstalledChromium("")).toBeUndefined();
  });
});
