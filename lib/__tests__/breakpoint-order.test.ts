import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import postcss, { type AtRule } from "postcss";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const GLOBALS = path.join(REPO, "app/globals.css");

const PROBES = [
  ["sm", "1901px", "40rem"],
  ["md", "1902px", "48rem"],
  ["lg", "1903px", "64rem"],
  ["xl", "1904px", "80rem"],
  ["2xl", "1905px", "96rem"],
  ["3xl", "1906px", "120rem"],
] as const;

describe("named breakpoint order (#3477)", () => {
  it("keeps custom named breakpoints in the same rem unit family", () => {
    const css = fs.readFileSync(GLOBALS, "utf8");
    const declarations = [
      ...css.matchAll(/--breakpoint-([\w-]+):\s*([^;]+);/g),
    ].map((match) => ({ name: match[1], value: match[2].trim() }));

    expect(
      declarations.length,
      "no custom named breakpoint was found"
    ).toBeGreaterThan(0);
    expect(
      declarations.filter(({ value }) => !/^\d+(?:\.\d+)?rem$/.test(value)),
      "Tailwind cannot sort px-valued custom named breakpoints against its rem-valued defaults"
    ).toEqual([]);
  });

  it("emits 3xl after the default rem-valued named breakpoints in a real Tailwind compile", async () => {
    const globals = fs.readFileSync(GLOBALS, "utf8");
    const candidates = PROBES.map(
      ([variant, value]) => `${variant}:max-w-[${value}]`
    ).join(" ");
    const result = await postcss([tailwindcss()]).process(
      `${globals}\n@source inline("${candidates}");`,
      { from: GLOBALS }
    );

    const emitted: { value: string; media: string }[] = [];
    result.root.walkDecls("max-width", (declaration) => {
      const probe = PROBES.find(([, value]) => value === declaration.value);
      if (!probe) return;
      const media = declaration.parent?.parent;
      if (media?.type !== "atrule" || media.name !== "media") {
        throw new Error(
          `${probe[0]} probe did not compile inside a media query`
        );
      }
      emitted.push({ value: probe[1], media: (media as AtRule).params });
    });

    expect(emitted).toEqual(
      PROBES.map(([, value, width]) => ({
        value,
        media: `(width >= ${width})`,
      }))
    );
  });
});
