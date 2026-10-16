import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const helper = readFileSync("deploy/files/internal-endpoints.cjs", "utf8");
const require = createRequire(import.meta.url);
function migrate(
  input: string,
  mode = "run",
  channel = "https://artifacts.example.internal/c/deck-ui/",
  standalone = true
) {
  let output = "";
  let status: number | undefined;
  const files = new Map<string | number, string>([
    [0, input],
    ...(standalone
      ? ([
          [
            "/app/server.js",
            'const nextConfig = {"allowedDevOrigins":["app.example.internal","localhost"]}\n',
          ],
        ] as const)
      : []),
    [
      "/app/public/deck-ui/0.1.1/ui/contract/places.json",
      JSON.stringify([
        { id: "search", href: "https://deck.example.internal/" },
      ]),
    ],
  ]);
  const stopped = new Error("exit");
  try {
    runInNewContext(helper, {
      URL,
      require: (name: string) =>
        name === "node:fs"
          ? {
              readFileSync: (file: string | number) => {
                if (!files.has(file)) throw new Error("Unexpected file");
                return files.get(file);
              },
              existsSync: (file: string) => files.has(file),
              readdirSync: () => ["0.1.1"],
            }
          : name === "/app/next.config.js" && !standalone
            ? { allowedDevOrigins: ["app.example.internal", "localhost"] }
            : require(name),
      process: {
        argv: ["node", mode],
        env: { DECK_UI_CHANNEL: channel },
        stdout: {
          write: (value: string) => {
            output += value;
          },
        },
        exit: (code: number) => {
          status = code;
          throw stopped;
        },
      },
    });
  } catch (error) {
    if (error !== stopped) throw error;
  }
  return { output, status };
}

describe("endpoint migration from the running release", () => {
  it("recovers missing values, preserves unrelated settings and is idempotent", () => {
    const input =
      "AI_BASE_URL=https://ai.example.internal\nOTHER=unchanged\nDECK_ORIGIN=\n";
    expect(migrate(input, "check").status).toBe(1);
    const { output } = migrate(input);
    expect(output).toContain("OTHER=unchanged");
    expect(require("node:util").parseEnv(output)).toMatchObject({
      CAPCOM_URL: "https://ai.example.internal",
      DECK_ORIGIN: "https://deck.example.internal",
      DECK_UI_CHANNEL: "https://artifacts.example.internal/c/deck-ui/",
      ALLOWED_DEV_ORIGINS: "app.example.internal,localhost",
    });
    expect(migrate(output, "check").status).toBe(0);
    expect(migrate(output).output).toBe(output);
  });

  it("recovers from a release older than the standalone image (no server.js)", () => {
    const input = "AI_BASE_URL=https://ai.example.internal\n";
    const { output } = migrate(
      input,
      "run",
      "https://artifacts.example.internal/c/deck-ui/",
      false
    );
    expect(require("node:util").parseEnv(output)).toMatchObject({
      ALLOWED_DEV_ORIGINS: "app.example.internal,localhost",
    });
  });

  it("preserves configured overrides and refuses incomplete recovery", () => {
    const input =
      "ALLOS_DECK_ORIGIN=https://custom.example.internal\nAI_BASE_URL=https://ai.example.internal\nCAPCOM_URL=https://custom-ai.example.internal\n";
    expect(require("node:util").parseEnv(migrate(input).output)).toMatchObject({
      DECK_ORIGIN: "https://custom.example.internal",
      CAPCOM_URL: "https://custom-ai.example.internal",
    });
    expect(() => migrate("OTHER=unchanged\n")).toThrow(
      "Cannot recover CAPCOM_URL"
    );
    expect(() => migrate(input, "run", "")).toThrow(
      "Cannot recover DECK_UI_CHANNEL"
    );
  });
});
