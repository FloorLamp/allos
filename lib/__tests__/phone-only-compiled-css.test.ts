import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const globals = fs.readFileSync(path.join(repo, "app", "globals.css"), "utf8");

function makeProofRoot(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-css-proof-"));
  for (const directory of ["app", "components", "lib"])
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, "app", "globals.css"), globals);
  fs.writeFileSync(path.join(root, "app", "candidate.tsx"), source);
  return root;
}

describe("compiled phone-only CSS proof (#3518)", () => {
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
