import { describe, it, expect } from "vitest";
import {
  sniffRawFormat,
  jsonKind,
  isJsonBranch,
  jsonCollapsedSummary,
  xmlCollapsedSummary,
  defaultBranchOpen,
  isLargePayload,
  rawDownload,
  sanitizeDownloadStem,
  RAW_DOWNLOAD_FALLBACK_STEM,
  LARGE_PAYLOAD_CHARS,
  DEFAULT_COLLAPSE_DEPTH,
} from "@/lib/raw-data-tree";

// #1318 — the pure tree model behind RawDataViewer: format sniff, the two node
// adapters' collapsed summaries, the depth default, and the size guard.
describe("sniffRawFormat", () => {
  it("recognizes JSON objects and arrays", () => {
    expect(sniffRawFormat('{"a":1}')).toBe("json");
    expect(sniffRawFormat("[1,2,3]")).toBe("json");
    expect(sniffRawFormat('  \n {"a":1} ')).toBe("json");
  });

  it("recognizes an XML candidate by its leading angle bracket", () => {
    expect(sniffRawFormat("<ClinicalDocument><a/></ClinicalDocument>")).toBe(
      "xml"
    );
    expect(sniffRawFormat("  <root/>")).toBe("xml");
  });

  it("falls back to text for anything else (incl. empty)", () => {
    expect(sniffRawFormat("just some prose")).toBe("text");
    expect(sniffRawFormat("")).toBe("text");
    expect(sniffRawFormat("   \n ")).toBe("text");
    // A bare JSON primitive is still valid JSON.
    expect(sniffRawFormat("42")).toBe("json");
    expect(sniffRawFormat('"hi"')).toBe("json");
  });
});

describe("jsonKind / isJsonBranch", () => {
  it("classifies primitives and branches", () => {
    expect(jsonKind(null)).toBe("null");
    expect(jsonKind([])).toBe("array");
    expect(jsonKind({})).toBe("object");
    expect(jsonKind(3)).toBe("number");
    expect(jsonKind(true)).toBe("boolean");
    expect(jsonKind("s")).toBe("string");
  });
  it("only objects and arrays are foldable branches", () => {
    expect(isJsonBranch({})).toBe(true);
    expect(isJsonBranch([])).toBe(true);
    expect(isJsonBranch(1)).toBe(false);
    expect(isJsonBranch(null)).toBe(false);
    expect(isJsonBranch("x")).toBe(false);
  });
});

describe("jsonCollapsedSummary", () => {
  it("summarizes arrays and objects, empty and non-empty", () => {
    expect(jsonCollapsedSummary([1, 2, 3])).toBe("items (3)");
    expect(jsonCollapsedSummary([])).toBe("empty");
    expect(jsonCollapsedSummary({ a: 1, b: 2 })).toBe("2 keys");
    expect(jsonCollapsedSummary({ a: 1 })).toBe("1 key");
    expect(jsonCollapsedSummary({})).toBe("empty");
  });
});

describe("xmlCollapsedSummary", () => {
  it("summarizes attribute and child counts with singular/plural", () => {
    expect(xmlCollapsedSummary({ attributeCount: 3, childCount: 2 })).toBe(
      "3 attrs · 2 children"
    );
    expect(xmlCollapsedSummary({ attributeCount: 1, childCount: 1 })).toBe(
      "1 attr · 1 child"
    );
    expect(xmlCollapsedSummary({ attributeCount: 0, childCount: 4 })).toBe(
      "4 children"
    );
    expect(xmlCollapsedSummary({ attributeCount: 2, childCount: 0 })).toBe(
      "2 attrs"
    );
    expect(xmlCollapsedSummary({ attributeCount: 0, childCount: 0 })).toBe(
      "empty"
    );
  });
});

describe("defaultBranchOpen + size guard", () => {
  it("opens shallow branches and closes deep ones", () => {
    expect(defaultBranchOpen(0, false)).toBe(true);
    expect(defaultBranchOpen(DEFAULT_COLLAPSE_DEPTH - 1, false)).toBe(true);
    expect(defaultBranchOpen(DEFAULT_COLLAPSE_DEPTH, false)).toBe(false);
  });
  it("a large payload forces every branch closed regardless of depth", () => {
    expect(defaultBranchOpen(0, true)).toBe(false);
  });
  it("isLargePayload keys on the char threshold", () => {
    expect(isLargePayload("x".repeat(LARGE_PAYLOAD_CHARS))).toBe(false);
    expect(isLargePayload("x".repeat(LARGE_PAYLOAD_CHARS + 1))).toBe(true);
  });
});

describe("rawDownload", () => {
  it("follows the format for extension, MIME, and label", () => {
    expect(rawDownload("json", "sync-payload-7")).toEqual({
      filename: "sync-payload-7.json",
      mime: "application/json",
      label: "Download JSON",
    });
    // The viewer serves CCD/XDM too, so an XML payload must not be handed to the
    // user as a .json file — the extension is the only clue left on disk.
    expect(rawDownload("xml", "sync-payload-7")).toEqual({
      filename: "sync-payload-7.xml",
      mime: "application/xml",
      label: "Download XML",
    });
    expect(rawDownload("text", "notes")).toEqual({
      filename: "notes.txt",
      mime: "text/plain",
      label: "Download",
    });
  });

  it("falls back to a generic stem rather than producing a dotfile", () => {
    expect(rawDownload("json").filename).toBe(
      `${RAW_DOWNLOAD_FALLBACK_STEM}.json`
    );
    expect(rawDownload("json", "").filename).toBe(
      `${RAW_DOWNLOAD_FALLBACK_STEM}.json`
    );
    // Sanitizes away to nothing → fallback, not ".json".
    expect(rawDownload("json", "///").filename).toBe(
      `${RAW_DOWNLOAD_FALLBACK_STEM}.json`
    );
  });

  it("strips path separators and unsafe characters from the stem", () => {
    expect(sanitizeDownloadStem("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeDownloadStem('a"b;c\nd')).toBe("a-b-c-d");
    expect(sanitizeDownloadStem("visit 2026-07-26")).toBe("visit-2026-07-26");
  });

  it("bounds the stem and never leaves a trailing separator before the dot", () => {
    const long = sanitizeDownloadStem("x".repeat(500));
    expect(long.length).toBeLessThanOrEqual(80);
    // A stem sliced mid-separator would otherwise yield "name-.json".
    expect(
      rawDownload("json", `${"y".repeat(79)} tail`).filename
    ).not.toContain("-.json");
  });
});
