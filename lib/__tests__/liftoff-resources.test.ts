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

it("binds exactly the declared secrets in the host scope, keeping other apps and fields", () => {
  const dir = makeTmpDir("resource-bindings");
  const step = resolve("deploy/steps/0008-resource-bindings.sh");
  try {
    writeFileSync(join(dir, "liftoff.json"), JSON.stringify(app));
    const scope = join(dir, "resources.json");
    const other = {
      secrets: { immich: { kind: "env", source: "/x/.env", key: "K" } },
    };
    const data = {
      database: { kind: "sqlite", source: "/opt/health/data/allos.db" },
    };
    const ai = {
      kind: "env",
      source: "/opt/compose/allos/.env",
      key: "ANTHROPIC_API_KEY",
    };
    writeFileSync(
      scope,
      JSON.stringify({
        version: 1,
        apps: { kinfolk: other, allos: { data, secrets: { ai } } },
      })
    );
    const library = join(dir, "step-lib.sh");
    writeFileSync(library, ":\n");
    const run = (mode: string) =>
      spawnSync("sh", [step, mode], {
        cwd: dir,
        env: { ...process.env, STEP_LIB: library, STEP_RESOURCES: scope },
        encoding: "utf8",
      });
    expect(run("check").status).toBe(1);
    expect(run("run").status).toBe(0);
    expect(run("check").status).toBe(0);
    const bound = JSON.parse(readFileSync(scope, "utf8"));
    expect(bound.apps.kinfolk).toEqual(other);
    expect(bound.apps.allos.data).toEqual(data);
    expect(Object.keys(bound.apps.allos.secrets).toSorted()).toEqual(
      app.resources.secrets.map((s: { name: string }) => s.name).toSorted()
    );
    expect(bound.apps.allos.secrets["habitat-token"]).toEqual({
      kind: "env",
      source: "/opt/compose/allos/.env",
      key: "HABITAT_TOKEN",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
