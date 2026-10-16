import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeTmpDir } from "./tmp-dir";

// The documented Deck gate is the only permitted insertion point. Synthetic
// config and reload command exercise the real step without touching a host.
describe("Deck Health route step", () => {
  it.each([false, true])(
    "is idempotent and restores a failed reload (%s)",
    (fail) => {
      const root = makeTmpDir("allos-route");
      try {
        mkdirSync(join(root, "allos"));
        mkdirSync(join(root, "caddy/conf"), { recursive: true });
        const config = join(root, "caddy/conf/Caddyfile");
        const original = `handle @deck {
    route {
        import member_gate deck
        reverse_proxy bridge:8080
    }
}
handle @allos {
    reverse_proxy allos:3000
}
`;
        writeFileSync(config, original);
        const lib = join(root, "lib.sh");
        writeFileSync(lib, 'install_file() { cp "$1" "$2"; }\n');
        const marker = join(root, "failed");
        writeFileSync(
          join(root, "caddy/reload.sh"),
          `#!/bin/sh\n${fail ? `[ -f '${marker}' ] || { touch '${marker}'; exit 1; }` : ":"}\n`,
          { mode: 0o755 }
        );
        const run = (mode: string) =>
          spawnSync(
            "sh",
            [resolve("deploy/steps/0005-deck-health-route.sh"), mode],
            {
              env: {
                ...process.env,
                STEP_LIB: lib,
                STEP_HOST: "prod",
                STEP_COMPOSE: join(root, "allos"),
              },
            }
          );
        expect(run("check").status).toBe(1);
        expect(readFileSync(config, "utf8")).toBe(original);
        expect(run("run").status).toBe(fail ? 2 : 0);
        if (fail) expect(readFileSync(config, "utf8")).toBe(original);
        expect(run("run").status).toBe(0);
        expect(run("check").status).toBe(0);
        const installed = readFileSync(config, "utf8");
        expect(
          installed.replace(
            /        # BEGIN allos-health[\s\S]*?        # END allos-health\n/,
            ""
          )
        ).toBe(original);
        expect(run("run").status).toBe(0);
        expect(readFileSync(config, "utf8")).toBe(installed);
        writeFileSync(
          config,
          original.replace(
            "import member_gate deck",
            "import member_gate other"
          )
        );
        expect(run("run").status).toBe(2);
        expect(readFileSync(config, "utf8")).not.toContain(
          "# BEGIN allos-health"
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
