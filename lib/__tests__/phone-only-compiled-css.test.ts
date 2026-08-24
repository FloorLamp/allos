import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertCompiledSheet,
  compilePhoneOnlyCss,
  compilePhoneOnlyCssText,
  inspectPhoneOnlyCss,
  provePhoneOnlyCss,
  stripPhoneContributions,
} from "../../scripts/phone-only-css-proof.mjs";
import {
  PHONE_BLOCK_FLOOR,
  PHONE_DECLARATION_FLOOR,
  PHONE_ONLY_UTILITIES,
} from "../../scripts/phone-only-css-registry.mjs";
import { makeTmpDir } from "./tmp-dir";

const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const globals = fs.readFileSync(path.join(repo, "app", "globals.css"), "utf8");
const proofRoots: string[] = [];

function makeProofRoot(source: string) {
  const root = makeTmpDir("phone-css-proof");
  proofRoots.push(root);
  for (const directory of ["app", "components", "lib"])
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "globals.css"), globals);
  fs.writeFileSync(path.join(root, "app", "candidate.tsx"), source);
  return root;
}

afterAll(() => {
  for (const root of proofRoots)
    fs.rmSync(root, { force: true, recursive: true });
});

function writeRuntimeSource(root: string, file: string, source: string) {
  const resolved = path.join(root, file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, source);
}

describe("compiled phone-only CSS proof (#3518)", { timeout: 60_000 }, () => {
  it("compiles the deterministic registry and proves every declaration is below sm", async () => {
    const css = await compilePhoneOnlyCss(repo);
    const receipt = inspectPhoneOnlyCss(css, { label: "branch" });
    expect(receipt.total).toBeGreaterThanOrEqual(PHONE_DECLARATION_FLOOR);
    expect(receipt.strippedBlocks).toBeGreaterThanOrEqual(PHONE_BLOCK_FLOOR);
    expect(receipt.strippedDeclarations).toBeGreaterThanOrEqual(
      PHONE_DECLARATION_FLOOR
    );
    expect(Object.keys(receipt.counts)).toEqual(
      PHONE_ONLY_UTILITIES.map(({ name }) => name)
    );
  });

  it("compiles branch and dependency-less control roots through the same boundary", async () => {
    const result = await provePhoneOnlyCss({
      branchRoot: repo,
      controlRoot: repo,
    });
    expect(result.branch.desktop).toBe(result.control.desktop);
  });

  it("fails loudly when compilation fails or returns an empty artifact", async () => {
    const broken = globals.replace(
      "@apply max-sm:p-3!;",
      "@apply max-sm:p-3! utility-that-does-not-exist;"
    );
    await expect(
      compilePhoneOnlyCssText(broken, { root: repo, label: "broken" })
    ).rejects.toThrow("broken: CSS compilation failed");
    expect(() => assertCompiledSheet("", "empty")).toThrow(
      "empty: CSS compilation produced no output"
    );
  });

  it("fails closed when a registered utility is renamed or missing", async () => {
    const renamed = globals.replaceAll(
      "subpanel-inset-xs",
      "subpanel-inset-xxs"
    );
    await expect(
      compilePhoneOnlyCssText(renamed, {
        root: repo,
        label: "renamed",
      })
    ).rejects.toThrow(
      "renamed: phone-contributing utility subpanel-inset-xxs is not registered"
    );
  });

  it("preserves whitespace-sensitive values and declaration winner order", async () => {
    const css = await compilePhoneOnlyCss(repo);
    const desktop = (extra: string) =>
      inspectPhoneOnlyCss(`${css}\n${extra}`, { label: "semantic desktop" })
        .desktop;

    expect(desktop('.proof-copy::after { content: "a  b"; }')).not.toBe(
      desktop('.proof-copy::after { content: "a b"; }')
    );
    expect(
      desktop("@layer properties { .proof-order { color: red; color: blue; } }")
    ).not.toBe(
      desktop("@layer properties { .proof-order { color: blue; color: red; } }")
    );
  });

  it("normalizes only unique atomic property registrations and fallbacks", async () => {
    const css = await compilePhoneOnlyCss(repo);
    const registrations = (order: readonly string[]) => `
      ${order
        .map(
          (name) =>
            `@property --proof-${name} { syntax: "<number>"; inherits: false; initial-value: 0; }`
        )
        .join("\n")}
      @layer properties {
        @supports ((-webkit-hyphens: none) and (not (margin-trim: inline))) or ((-moz-orient: inline) and (not (color:rgb(from red r g b)))) {
          *, ::before, ::after, ::backdrop {
            ${order.map((name) => `--proof-${name}: 0;`).join("\n")}
          }
        }
      }
    `;
    const desktop = (extra: string) =>
      inspectPhoneOnlyCss(`${css}\n${extra}`, { label: "registrations" })
        .desktop;

    expect(desktop(registrations(["a", "b"]))).toBe(
      desktop(registrations(["b", "a"]))
    );
    expect(
      desktop(
        '@property --proof-order { syntax: "<number>"; inherits: false; initial-value: 0; }'
      )
    ).not.toBe(
      desktop(
        '@property --proof-order { initial-value: 0; inherits: false; syntax: "<number>"; }'
      )
    );
    expect(() =>
      desktop(
        `${registrations(["a", "b"])}\n@property --proof-a { syntax: "*"; inherits: false; }`
      )
    ).toThrow("duplicate @property registration --proof-a");
    expect(() =>
      desktop(
        registrations(["a", "b"]).replace(
          "--proof-a: 0;",
          "--proof-a: 0; --proof-a: 1;"
        )
      )
    ).toThrow("duplicate fallback declaration --proof-a");
  });

  it("fails closed when a phone-contributing utility is omitted from the registry", async () => {
    const omitted = `${globals}\n@utility omitted-phone-utility { color: red; @apply max-sm:p-2; }`;
    await expect(
      compilePhoneOnlyCssText(omitted, { root: repo, label: "omitted" })
    ).rejects.toThrow(
      "omitted: phone-contributing utility omitted-phone-utility is not registered"
    );
  });

  it("includes every custom utility and each root's real callsite candidates", async () => {
    const baseCss = await compilePhoneOnlyCss(repo);
    const customCss = await compilePhoneOnlyCssText(
      `${globals}\n@utility collateral-desktop { color: red; }`,
      { root: repo, label: "custom utility" }
    );
    expect(customCss).toContain(".collateral-desktop");
    expect(
      inspectPhoneOnlyCss(customCss, { label: "custom utility" }).desktop
    ).not.toBe(inspectPhoneOnlyCss(baseCss, { label: "base" }).desktop);

    const branchRoot = makeProofRoot(
      'export const Candidate = () => <div className="p-8" />;\n'
    );
    const controlRoot = makeProofRoot(
      'export const Candidate = () => <div className="p-4" />;\n'
    );
    await expect(
      provePhoneOnlyCss({ branchRoot, controlRoot })
    ).rejects.toThrow("desktop-visible compiled declarations differ");

    fs.writeFileSync(
      path.join(branchRoot, "components", "classes.ts"),
      'export const DESKTOP_CLASS = "m-8";\n'
    );
    fs.writeFileSync(
      path.join(branchRoot, "app", "candidate.tsx"),
      'import { DESKTOP_CLASS } from "../components/classes";\nexport const Candidate = () => <div className={DESKTOP_CLASS} />;\n'
    );
    await expect(
      provePhoneOnlyCss({ branchRoot, controlRoot })
    ).rejects.toThrow("desktop-visible compiled declarations differ");

    fs.writeFileSync(
      path.join(branchRoot, "app", "candidate.tsx"),
      'export const Candidate = () => <div className="p-4">p-8</div>;\n'
    );
    await expect(
      provePhoneOnlyCss({ branchRoot, controlRoot })
    ).resolves.toBeDefined();
  });

  it("follows aliased named imports by symbol", async () => {
    const candidate =
      'import { DESKTOP_CLASS as BOX_CLASS } from "../components/classes";\nexport const Candidate = () => <div className={BOX_CLASS} />;\n';
    const branchRoot = makeProofRoot(candidate);
    const controlRoot = makeProofRoot(candidate);
    writeRuntimeSource(
      branchRoot,
      "components/classes.ts",
      'export const DESKTOP_CLASS = "m-8";\n'
    );
    writeRuntimeSource(
      controlRoot,
      "components/classes.ts",
      'export const DESKTOP_CLASS = "m-4";\n'
    );

    await expect(
      provePhoneOnlyCss({ branchRoot, controlRoot })
    ).rejects.toThrow("desktop-visible compiled declarations differ");
  });

  it("does not merge shadowed or same-named declarations", async () => {
    const candidate = (local: string, unrelated: string) => `
      const BOX_CLASS = "${unrelated}";
      export function Candidate() {
        const BOX_CLASS = "${local}";
        return <div className={BOX_CLASS} />;
      }
    `;
    const branchRoot = makeProofRoot(candidate("m-8", "m-4"));
    const controlRoot = makeProofRoot(candidate("m-4", "m-8"));
    writeRuntimeSource(
      branchRoot,
      "components/unrelated.ts",
      'export const BOX_CLASS = "m-4";\n'
    );
    writeRuntimeSource(
      controlRoot,
      "components/unrelated.ts",
      'export const BOX_CLASS = "m-8";\n'
    );

    await expect(
      provePhoneOnlyCss({ branchRoot, controlRoot })
    ).rejects.toThrow("desktop-visible compiled declarations differ");
  });

  it("follows default imports and re-export aliases", async () => {
    const defaultCandidate =
      'import BOX_CLASS from "../components/classes";\nexport const Candidate = () => <div className={BOX_CLASS} />;\n';
    const defaultBranch = makeProofRoot(defaultCandidate);
    const defaultControl = makeProofRoot(defaultCandidate);
    writeRuntimeSource(
      defaultBranch,
      "components/classes.ts",
      'const BOX_CLASS = "m-8";\nexport default BOX_CLASS;\n'
    );
    writeRuntimeSource(
      defaultControl,
      "components/classes.ts",
      'const BOX_CLASS = "m-4";\nexport default BOX_CLASS;\n'
    );
    await expect(
      provePhoneOnlyCss({
        branchRoot: defaultBranch,
        controlRoot: defaultControl,
      })
    ).rejects.toThrow("desktop-visible compiled declarations differ");

    const reexportCandidate =
      'import { REEXPORTED_CLASS as BOX_CLASS } from "../components/bridge";\nexport const Candidate = () => <div className={BOX_CLASS} />;\n';
    const reexportBranch = makeProofRoot(reexportCandidate);
    const reexportControl = makeProofRoot(reexportCandidate);
    for (const [root, value] of [
      [reexportBranch, "m-8"],
      [reexportControl, "m-4"],
    ] as const) {
      writeRuntimeSource(
        root,
        "components/classes.ts",
        `const BOX_CLASS = "${value}";\nexport default BOX_CLASS;\n`
      );
      writeRuntimeSource(
        root,
        "components/bridge.ts",
        'export { default as REEXPORTED_CLASS } from "./classes";\n'
      );
    }
    await expect(
      provePhoneOnlyCss({
        branchRoot: reexportBranch,
        controlRoot: reexportControl,
      })
    ).rejects.toThrow("desktop-visible compiled declarations differ");
  });

  it("fails closed on an unresolved class-bearing import", async () => {
    const brokenRoot = makeProofRoot(
      'import { MISSING_CLASS } from "../components/missing";\nexport const Candidate = () => <div className={MISSING_CLASS} />;\n'
    );
    await expect(
      compilePhoneOnlyCss(brokenRoot, { label: "unresolved" })
    ).rejects.toThrow(
      "unresolved: cannot resolve class-bearing binding MISSING_CLASS"
    );
  });

  it("still reads arguments of an unresolved package class helper", async () => {
    const candidate = (value: string) =>
      `import clsx from "uninstalled-class-helper";\nexport const Candidate = () => <div className={clsx("${value}")} />;\n`;
    const branchRoot = makeProofRoot(candidate("m-8"));
    const controlRoot = makeProofRoot(candidate("m-4"));
    await expect(
      provePhoneOnlyCss({ branchRoot, controlRoot })
    ).rejects.toThrow("desktop-visible compiled declarations differ");
  });

  it("rejects a declaration leaked from a registered utility onto desktop", async () => {
    const leaked = globals.replace(
      "@utility subpanel-inset {",
      "@utility subpanel-inset {\n  color: red;"
    );
    const css = await compilePhoneOnlyCssText(leaked, {
      root: repo,
      label: "leaked",
    });
    expect(() => inspectPhoneOnlyCss(css, { label: "leaked" })).toThrow(
      "registered phone-only declarations can apply at sm or above"
    );
  });

  it("strips only the two exact phone scopes, recursively", () => {
    const css = `
      @layer utilities {
        @media (width < 40rem) { .phone-a { display: block } }
        @media (max-width: 639.98px) { .phone-b { display: block } }
        @media (width < 50rem) { .not-phone { display: block } }
        @media (min-width: 40rem) { .desktop { display: block } }
      }
    `;
    const result = stripPhoneContributions(css);
    expect(result.blocks).toBe(2);
    expect(result.declarations).toBe(2);
    const kept = result.root.toString();
    expect(kept).not.toContain("phone-a");
    expect(kept).not.toContain("phone-b");
    expect(kept).toContain("width < 50rem");
    expect(kept).toContain("min-width: 40rem");
  });
});
