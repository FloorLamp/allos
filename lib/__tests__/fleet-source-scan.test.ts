import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Hashes cover case-insensitive owner name tokens without publishing the names.
const nameHashes = new Set([
  "c57b3f1cd05e94f3c1ca812c4f0665040e47ab7b889ebb66cf190f84ce48ab62",
  "2ac81299578013795576682809a4a16d1ecca67118a797ea576c113c41786849",
  "f1946de6883a2cdff67e73f3a7390810bf0fc9e2c415ce5025e8f5acdd72158f",
]);
const patterns = [
  /\b(?:[a-z0-9-]+\.)*w[a]ng\.team\b/i,
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.home(?=[/:'"\s]|$)/i,
  /(?<![\d.])(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2})(?![\d.])/,
];
const hash = (value: string) =>
  createHash("sha256").update(value.toLowerCase()).digest("hex");

function scan(root: string, files: string[]): string[] {
  const names = new Map<string, boolean>();
  const isName = (word: string) => {
    const key = word.toLowerCase();
    if (!names.has(key)) names.set(key, nameHashes.has(hash(key)));
    return names.get(key);
  };
  return files.flatMap((file) => {
    if (
      file.startsWith("public/deck-ui/") ||
      (!/\.(?:[cm]?[jt]sx?|json|sh|md|ya?ml)$/.test(file) &&
        ![".env.example", "Dockerfile"].includes(file)) ||
      file === "package-lock.json"
    )
      return [];
    return readFileSync(join(root, file), "utf8")
      .split(/\r?\n/)
      .flatMap((line, i) =>
        patterns.some((pattern) => pattern.test(line)) ||
        (line.match(/[a-z]+/gi) ?? []).some(isName)
          ? [`${file}:${i + 1}`]
          : []
      );
  });
}

function discover(root: string): string[] {
  return execFileSync(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean);
}

describe("public source contains no fleet configuration", () => {
  it("scans every Git-visible source file except the upstream bundle", () => {
    const root = process.cwd();
    expect(scan(root, discover(root))).toEqual([]);
  });

  it("finds hostnames, private addresses and names without flagging OIDs or properties", () => {
    const root = process.cwd();
    const file = `lib/__tests__/fleet-source-fixture-${process.pid}.ts`;
    const forbidden = [
      ["service", "home"].join("."),
      ["service", "w" + "ang", "team"].join("."),
      [10, 20, 30, 40].join("."),
      [192, 168, 1, 2].join("."),
      "SyntheticOwner",
    ];
    nameHashes.add(hash("SyntheticOwner"));
    try {
      writeFileSync(
        join(root, file),
        forbidden.join("\n") +
          "\nconst value = scopes.home; // OID 2.16.840.1.113883.10.20.22.4.8\nhttps://example.internal"
      );
      const found = discover(root).filter((path) => path === file);
      expect(scan(root, found)).toEqual(
        forbidden.map((_, i) => `${file}:${i + 1}`)
      );
    } finally {
      nameHashes.delete(hash("SyntheticOwner"));
      rmSync(join(root, file), { force: true });
    }
  });
});
