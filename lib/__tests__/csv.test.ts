import { describe, expect, it } from "vitest";
import { toCsv } from "@/lib/csv";

describe("toCsv", () => {
  it("emits a header row and one row per record", () => {
    const out = toCsv(
      ["a", "b"],
      [
        { a: "1", b: "2" },
        { a: "3", b: "4" },
      ]
    );
    expect(out).toBe("a,b\n1,2\n3,4\n");
  });

  it("quotes fields with commas, quotes, or newlines and doubles quotes", () => {
    const out = toCsv(
      ["x"],
      [{ x: "a,b" }, { x: 'he said "hi"' }, { x: "line1\nline2" }]
    );
    expect(out).toBe('x\n"a,b"\n"he said ""hi"""\n"line1\nline2"\n');
  });

  it("renders null/undefined and missing keys as empty cells", () => {
    const out = toCsv(["a", "b"], [{ a: null, b: undefined }, {}]);
    expect(out).toBe("a,b\n,\n,\n");
  });

  it("neutralizes formula-injection in string cells", () => {
    const out = toCsv(
      ["f"],
      [
        { f: "=1+1" },
        { f: "+cmd" },
        { f: "-danger" },
        { f: "@SUM(A1)" },
        { f: "\t=leadingtab" },
      ]
    );
    // Each dangerous string is prefixed with a single quote. The tab/`=` case
    // also contains no comma/quote/newline, so it is not additionally quoted.
    expect(out).toBe("f\n'=1+1\n'+cmd\n'-danger\n'@SUM(A1)\n'\t=leadingtab\n");
  });

  it("leaves genuine numeric cells (including negatives) untouched", () => {
    const out = toCsv(["n"], [{ n: -5 }, { n: 42 }, { n: -3.14 }]);
    expect(out).toBe("n\n-5\n42\n-3.14\n");
  });
});
