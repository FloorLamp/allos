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
    reverse_proxy 203.0.113.10:3000
}
`;
        const broken = original.replace(
          "        reverse_proxy bridge:8080",
          `        # BEGIN allos-health
        @allos_health path /health /health/*
        handle @allos_health {
            reverse_proxy allos:3000
        }
        # END allos-health
        reverse_proxy bridge:8080`
        );
        writeFileSync(config, broken);
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
            [resolve("deploy/steps/0006-deck-health-target.sh"), mode],
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
        expect(readFileSync(config, "utf8")).toBe(broken);
        const result = run("run");
        expect(result.status, result.stderr.toString()).toBe(fail ? 2 : 0);
        if (fail) expect(readFileSync(config, "utf8")).toBe(broken);
        expect(run("run").status).toBe(0);
        expect(run("check").status).toBe(0);
        const installed = readFileSync(config, "utf8");
        expect(installed).toContain("reverse_proxy 203.0.113.10:3000");
        expect(installed).not.toContain("reverse_proxy allos:3000");
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

  it("0006 moves 0005's block to allos's own upstream with the gate's indent", () => {
    // allos's own site handler (@allos): a matched boarding proxy, then the site's upstream (a documentation address).
    const site =
      "\thandle @allos {\n\t\troute {\n\t\t\treverse_proxy @allos_boarding boarding:9816\n" +
      "\t\t\treverse_proxy 192.0.2.10:3000\n\t\t}\n\t}\n";
    // 0005 proxied allos:3000, which Caddy cannot resolve: Deck Health 502 (spaceport#995).
    const root = makeTmpDir("allos-route");
    try {
      mkdirSync(join(root, "allos"));
      mkdirSync(join(root, "caddy/conf"), { recursive: true });
      const config = join(root, "caddy/conf/Caddyfile");
      writeFileSync(
        config,
        "\t\troute {\n\t\t\timport member_gate deck\n" +
          "        # BEGIN allos-health\n        @allos_health path /health /health/*\n" +
          "        handle @allos_health {\n            reverse_proxy allos:3000\n        }\n" +
          "        # END allos-health\n\t\t\treverse_proxy bridge:8080\n\t\t}\n" +
          site
      );
      const lib = join(root, "lib.sh");
      writeFileSync(lib, 'install_file() { cp "$1" "$2"; }\n');
      writeFileSync(join(root, "caddy/reload.sh"), "#!/bin/sh\n:\n", {
        mode: 0o755,
      });
      const run = (mode: string) =>
        spawnSync(
          "sh",
          [resolve("deploy/steps/0006-deck-health-target.sh"), mode],
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
      expect(run("run").status).toBe(0);
      expect(run("check").status).toBe(0);
      expect(readFileSync(config, "utf8")).toBe(
        "\t\troute {\n\t\t\timport member_gate deck\n" +
          "\t\t\t# BEGIN allos-health\n\t\t\t@allos_health path /health /health/*\n" +
          "\t\t\thandle @allos_health {\n\t\t\t\treverse_proxy 192.0.2.10:3000\n\t\t\t}\n" +
          "\t\t\t# END allos-health\n\t\t\treverse_proxy bridge:8080\n\t\t}\n" +
          site
      );
      // no single unmatched upstream in allos's own handler: fail closed, nothing changed
      writeFileSync(config, "\t\t\timport member_gate deck\n");
      expect(run("run").status).toBe(2);
      expect(readFileSync(config, "utf8")).toBe(
        "\t\t\timport member_gate deck\n"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
