import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// Exercise the scheduled job's gate with npm's advisory response, offline.
test("the security job rejects vulnerable Vite and accepts its patched report", () => {
  const directory = makeTmpDir("audit");
  const advisory = (id: string) => ({
    url: `https://github.com/advisories/${id}`,
  });
  const vulnerabilities = {
    braces: {
      severity: "high",
      via: [advisory("GHSA-vfj7-8cjw-p6xm")],
    },
    vite: {
      severity: "high",
      via: [
        advisory("GHSA-698v-4r3x-3vcv"),
        advisory("GHSA-r825-w8mm-5pxw"),
        advisory("GHSA-587h-7wmj-h5pm"),
      ],
    },
  };
  try {
    writeFileSync(
      join(directory, "npm"),
      '#!/bin/sh\ncat "$AUDIT_FIXTURE"\nexit 1\n',
      { mode: 0o755 }
    );
    const fixture = join(directory, "report.json");
    const env = {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      AUDIT_FIXTURE: fixture,
    };
    const gate = resolve("scripts/audit-gate.mjs");
    writeFileSync(fixture, JSON.stringify({ vulnerabilities }));
    const vulnerable = spawnSync(process.execPath, [gate], {
      env,
      encoding: "utf8",
    });
    expect(vulnerable.status).toBe(1);
    expect(vulnerable.stderr).toContain("vite: high");
    expect(vulnerable.stderr).toContain("GHSA-587h-7wmj-h5pm");

    writeFileSync(
      fixture,
      JSON.stringify({ vulnerabilities: { braces: vulnerabilities.braces } })
    );
    expect(
      execFileSync(process.execPath, [gate], { env, encoding: "utf8" })
    ).toContain("audit-gate: OK");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
