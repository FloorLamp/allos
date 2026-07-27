import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_HEALTH_BYTES, MULTIPART_OVERHEAD_MARGIN } from "../upload-gate";
import { MAX_VIDEO_BYTES } from "../video/policy";

// SOURCE-SCAN tier (issue #696). f9926a0 introduced a cross-file numeric
// invariant the code comments call load-bearing: next.config.js's two transport
// caps (serverActions.bodySizeLimit AND experimental.proxyClientMaxBodySize) must
// stay >= the app's own MAX_HEALTH_BYTES ceiling plus the documented multipart
// overhead margin — or Next truncates/rejects an over-cap upload body before
// ingestMedicalUpload ever runs, silently reintroducing the "large upload
// truncated" bug f9926a0 fixed. Nothing guarded it. This test reads next.config.js
// as TEXT (no build, no network, so it stays "pure" in the vitest sense) and pins
// both caps against MAX_HEALTH_BYTES, the same idiom as the immediate-tx /
// telegram-chokepoint guards. It imports the byte ceilings from the PURE
// lib/upload-gate module (which lib/medical-pipeline re-exports) so it can stay in
// the DB-free unit tier.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const CONFIG = path.join(REPO, "next.config.js");

// Parse a "65mb" / "10mb" size string the way Next's bundled `bytes` package does:
// the k/m/g units are BINARY (powers of 1024), matching the "+1MB (1MiB) overhead"
// the config comments document. Kept as a tiny local parser so this test needs no
// dependency (`bytes` is compiled into Next, not a top-level package).
function parseSize(value: string): number {
  const m = /^([\d.]+)\s*(b|kb|mb|gb)?$/i.exec(value.trim());
  if (!m) throw new Error(`unparseable size: ${value}`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || "b").toLowerCase();
  const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit]!;
  return Math.floor(n * factor);
}

function configSize(source: string, key: string): number {
  const m = new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`).exec(source);
  expect(m, `next.config.js is missing a ${key} setting`).toBeTruthy();
  return parseSize(m![1]);
}

describe("upload-size lockstep (issues #696/#1364)", () => {
  const source = fs.readFileSync(CONFIG, "utf8");

  // The transport cap must clear the LARGEST permitted upload by at least the
  // multipart-framing margin, or Next mangles the body first. There are two upload
  // paths bound by these transport caps — deterministic health records
  // (MAX_HEALTH_BYTES, 64MB) and video clips (MAX_VIDEO_BYTES, 100MB, #1364) — and a
  // plain "use server" video action is fully bound by them just like the medical
  // upload, so the governing floor is whichever app cap is biggest plus the margin.
  const largestUpload = Math.max(MAX_HEALTH_BYTES, MAX_VIDEO_BYTES);
  const floor = largestUpload + MULTIPART_OVERHEAD_MARGIN;

  it("serverActions.bodySizeLimit stays >= the largest app upload cap + overhead margin", () => {
    expect(configSize(source, "bodySizeLimit")).toBeGreaterThanOrEqual(floor);
  });

  it("experimental.proxyClientMaxBodySize stays >= the largest app upload cap + overhead margin", () => {
    expect(configSize(source, "proxyClientMaxBodySize")).toBeGreaterThanOrEqual(
      floor
    );
  });

  it("both transport caps clear MAX_VIDEO_BYTES + overhead margin (#1364)", () => {
    const videoFloor = MAX_VIDEO_BYTES + MULTIPART_OVERHEAD_MARGIN;
    expect(configSize(source, "bodySizeLimit")).toBeGreaterThanOrEqual(
      videoFloor
    );
    expect(configSize(source, "proxyClientMaxBodySize")).toBeGreaterThanOrEqual(
      videoFloor
    );
  });

  it("parseSize reads binary MB the way Next's bytes package does", () => {
    expect(parseSize("65mb")).toBe(65 * 1024 * 1024);
    expect(parseSize("1kb")).toBe(1024);
  });

  // The Fitbit Takeout import is the one upload that does NOT clear the transport
  // cap and is not supposed to: a Takeout export is ~250MB, and lifting
  // proxyClientMaxBodySize that high would make every middleware-matched route
  // buffer a quarter-gigabyte body to serve one importer. It escapes instead — the
  // route is excluded from the middleware matcher, so no body clone (and no
  // truncation) happens on that path.
  //
  // That exclusion is load-bearing and invisible: delete it and nothing fails to
  // compile, no test that existed before this one goes red, and the handler's 1 GiB
  // cap quietly becomes a false promise — Next truncates the body to the cap
  // (it warns rather than rejecting), the ZIP's end-of-central-directory record
  // goes with the tail, and a real import 500s with "Not a valid ZIP archive".
  // That is exactly the "silently reintroduced" failure this file exists to catch,
  // so the exemption is pinned here beside the caps it opts out of.
  describe("Fitbit Takeout import escapes the transport cap (#1571)", () => {
    const ROUTE = "app/api/integrations/fitbit-takeout/import/route.ts";
    const MATCHER_PATH = "api/integrations/fitbit-takeout/import";
    const middleware = fs.readFileSync(
      path.join(REPO, "middleware.ts"),
      "utf8"
    );

    it("the route is excluded from the middleware matcher", () => {
      const m = /matcher:\s*\[([\s\S]*?)\]/.exec(middleware);
      expect(m, "middleware.ts is missing a matcher").toBeTruthy();
      expect(
        m![1],
        `middleware's matcher must exclude ${MATCHER_PATH} — otherwise Next clones ` +
          `and truncates the archive body at proxyClientMaxBodySize and the import 500s`
      ).toContain(MATCHER_PATH);
    });

    it("the excluded path still names a real route handler", () => {
      // A matcher exclusion is a string, so a moved/renamed route would leave the
      // exclusion pointing at nothing AND put the live route back under the cap —
      // silently, since neither half is a compile error.
      expect(
        fs.existsSync(path.join(REPO, ROUTE)),
        `${ROUTE} moved — update the middleware matcher exclusion to match`
      ).toBe(true);
    });

    it("the handler enforces its own cap, since the transport one no longer applies", () => {
      const source = fs.readFileSync(path.join(REPO, ROUTE), "utf8");
      expect(source).toMatch(/DEFAULT_MAX_TAKEOUT_BYTES\s*=/);
      expect(source).toContain("resolveMaxTakeoutBytes");
    });
  });
});
