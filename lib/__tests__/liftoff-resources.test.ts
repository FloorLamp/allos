import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

const app = JSON.parse(readFileSync("deploy/liftoff.json", "utf8"));

describe("Allos deployment resource consumers", () => {
  // Both containers share .env and /app/data in docker-compose.yml. Liftoff
  // rejects resources exposed to a service outside their declared recipients.
  it.each([...app.resources.data, ...app.resources.secrets])(
    "$name authorizes the app and notification worker",
    (resource) => {
      const recipients = resource.services ?? [app.services[0]];
      expect(recipients.toSorted()).toEqual(["allos", "allos-notify"]);
    }
  );
});

it("repairs the host manifest without replacing host settings", () => {
  const dir = makeTmpDir("resource-step");
  const step = resolve("deploy/steps/0004-resource-consumers.sh");
  try {
    const original = structuredClone(app);
    for (const resource of [
      ...original.resources.data,
      ...original.resources.secrets,
    ]) {
      delete resource.services;
    }
    original.timeout = 180;
    writeFileSync(join(dir, "liftoff.json"), JSON.stringify(original));
    const library = join(dir, "step-lib.sh");
    writeFileSync(library, 'install_file() { cp "$1" "$2"; }\n');
    const run = (mode: string) =>
      spawnSync("sh", [step, mode], {
        cwd: dir,
        env: { ...process.env, STEP_LIB: library },
        encoding: "utf8",
      });
    expect(run("check").status).toBe(1);
    expect(run("run").status).toBe(0);
    expect(run("check").status).toBe(0);
    const repaired = readFileSync(join(dir, "liftoff.json"), "utf8");
    expect(JSON.parse(repaired)).toEqual({ ...app, timeout: 180 });
    expect(run("run").status).toBe(0);
    expect(readFileSync(join(dir, "liftoff.json"), "utf8")).toBe(repaired);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("binds Allos resources while preserving other host scope under concurrent runs", async () => {
  const dir = makeTmpDir("resource-bindings");
  try {
    const path = join(dir, "resources.json");
    const original = {
      version: 1,
      apps: {
        allos: {
          secrets: {
            ai: { kind: "env", source: "old.env", key: "ANTHROPIC_API_KEY" },
            "habitat-url": {
              kind: "env",
              source: "host.env",
              key: "HABITAT_URL",
            },
          },
          data: { database: { kind: "sqlite", source: "allos.db" } },
          maxBytes: 2147483648,
        },
        other: { secrets: {}, maxBytes: 1073741824 },
      },
    };
    writeFileSync(path, JSON.stringify(original));
    const library = join(dir, "step-lib.sh");
    writeFileSync(library, "");
    const options = {
      cwd: dir,
      env: {
        ...process.env,
        STEP_LIB: library,
        STEP_RESOURCES: path,
        STEP_COMPOSE: dir,
      },
      encoding: "utf8" as const,
    };
    const step = resolve("deploy/steps/0008-resource-bindings.sh");
    expect(spawnSync("sh", [step, "check"], options).status).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
    const { spawn } = await import("node:child_process");
    const run = () =>
      new Promise<number | null>((done, reject) => {
        const child = spawn("sh", [step, "run"], options);
        child.on("error", reject);
        child.on("exit", done);
      });
    expect(await Promise.all([run(), run()])).toEqual([0, 0]);
    expect(spawnSync("sh", [step, "check"], options).status).toBe(0);
    const repaired = JSON.parse(readFileSync(path, "utf8"));
    const { ai: _retired, ...kept } = original.apps.allos.secrets;
    const expected = Object.fromEntries(
      app.resources.secrets
        .filter((resource: { name: string }) => resource.name !== "habitat-url")
        .map((resource: { name: string; env: string }) => [
          resource.name,
          { kind: "env", source: join(dir, ".env"), key: resource.env },
        ])
    );
    expect(repaired).toEqual({
      ...original,
      apps: {
        ...original.apps,
        allos: { ...original.apps.allos, secrets: { ...kept, ...expected } },
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
