import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (...parts: string[]) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");

describe("the notification tick module boundary (#3085)", () => {
  const tick = read("lib", "notifications", "tick.ts");
  const cli = read("scripts", "notify.ts");

  it("keeps process termination in the CLI layer", () => {
    expect(tick).not.toMatch(/process\.exit\s*\(/);
    expect(cli).toMatch(/process\.exit\s*\(/);
  });

  it("exports the per-profile tick and leaves fan-out in the CLI", () => {
    expect(tick).toMatch(
      /export async function tickProfile\s*\(\s*profileId: number/
    );
    expect(tick).toMatch(
      /export async function runDigestTick\s*\(\s*profileId: number/
    );
    expect(tick).toMatch(
      /export async function runManualNotification\s*\(\s*profileId: number/
    );
    expect(cli).toMatch(/for \(const profile of profiles\)/);
  });

  it("keeps the unrestricted profile census in the CLI boundary", () => {
    expect(tick).not.toMatch(/SELECT id, name FROM profiles/);
    expect(cli).toMatch(/SELECT id, name FROM profiles/);
  });

  it("passes the simulated moment into the integration pull pass", () => {
    expect(tick).toMatch(/const now = new Date\(nowMs\)/);
    expect(tick).toMatch(/syncIntegrations\(profileId, now\)/);
    expect(tick).not.toMatch(/syncIntegrations\(profileId\)/);
  });
});
