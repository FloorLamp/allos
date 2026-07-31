import { describe, expect, it } from "vitest";
import {
  contentTypeFor,
  exitCodeFor,
  formatResultTable,
  parseArgs,
  resolveProfiles,
  type UploadResult,
} from "../../scripts/upload-docs";

// PURE TIER (issue #1735) — the CLI's argument parsing, profile resolution and exit-code
// mapping, extracted from scripts/upload-docs.ts so the decisions are pinned without a
// network call. Importing the module must not run it; the script's entry point is
// guarded on being invoked directly, and this suite passing at all is that guard's test.

const ok = (r: ReturnType<typeof parseArgs>) => {
  if (!r.ok) throw new Error(`expected parse to succeed: ${r.error}`);
  return r.args;
};

describe("parseArgs", () => {
  it("reads a url, repeated profiles, and the files", () => {
    const a = ok(
      parseArgs([
        "--url",
        "https://allos.example",
        "--profile",
        "alice",
        "--profile",
        "2",
        "labs.pdf",
        "scan.jpg",
      ])
    );
    expect(a.url).toBe("https://allos.example");
    expect(a.profiles).toEqual(["alice", "2"]);
    expect(a.files).toEqual(["labs.pdf", "scan.jpg"]);
  });

  it("accepts --flag=value form", () => {
    const a = ok(
      parseArgs(["--url=https://allos.example", "--profile=alice", "labs.pdf"])
    );
    expect(a.url).toBe("https://allos.example");
    expect(a.profiles).toEqual(["alice"]);
  });

  it("falls back to ALLOS_URL for the base url", () => {
    const a = ok(
      parseArgs(["--profile", "alice", "labs.pdf"], {
        ALLOS_URL: "https://from-env.example",
      })
    );
    expect(a.url).toBe("https://from-env.example");
  });

  it("--help short-circuits every other requirement", () => {
    expect(ok(parseArgs(["--help"])).help).toBe(true);
    expect(ok(parseArgs(["-h"])).help).toBe(true);
  });

  it("--list needs a url but no profile or files", () => {
    const a = ok(parseArgs(["--url", "https://allos.example", "--list"]));
    expect(a.list).toBe(true);
    expect(a.profiles).toEqual([]);
  });

  it("refuses a missing url, profile, or file list", () => {
    expect(parseArgs(["--profile", "alice", "labs.pdf"])).toEqual({
      ok: false,
      error: "--url is required",
    });
    expect(parseArgs(["--url", "https://x", "labs.pdf"])).toEqual({
      ok: false,
      error: "at least one --profile is required",
    });
    expect(parseArgs(["--url", "https://x", "--profile", "alice"])).toEqual({
      ok: false,
      error: "no files given",
    });
  });

  it("refuses a flag with no value", () => {
    expect(parseArgs(["--url"]).ok).toBe(false);
    expect(parseArgs(["--url", "https://x", "--profile"]).ok).toBe(false);
  });

  it("refuses an unknown option rather than treating it as a filename", () => {
    // A typo'd `--profil alice` must not quietly try to upload a file named "alice".
    const r = parseArgs(["--url", "https://x", "--profil", "alice", "a.pdf"]);
    expect(r).toEqual({ ok: false, error: "unknown option: --profil" });
  });

  it("never reads a token from argv", () => {
    // The token comes from ALLOS_TOKEN only — process lists and shell history leak
    // command lines. There is deliberately no --token flag to parse.
    expect(parseArgs(["--url", "https://x", "--token", "abc"]).ok).toBe(false);
  });
});

describe("resolveProfiles", () => {
  const available = [
    { id: 1, name: "Alice" },
    { id: 2, name: "Bob" },
    { id: 5, name: "Sam (1)" },
    { id: 6, name: "Sam (2)" },
  ];

  it("resolves a bare number as an id", () => {
    const r = resolveProfiles(["2"], available);
    expect(r.ok && r.profiles).toEqual([{ id: 2, name: "Bob" }]);
  });

  it("resolves a name case- and whitespace-insensitively", () => {
    const r = resolveProfiles(["  aLiCe "], available);
    expect(r.ok && r.profiles).toEqual([{ id: 1, name: "Alice" }]);
  });

  it("resolves the app's disambiguated labels verbatim", () => {
    const r = resolveProfiles(["Sam (2)"], available);
    expect(r.ok && r.profiles).toEqual([{ id: 6, name: "Sam (2)" }]);
  });

  it("dedupes a profile named twice", () => {
    const r = resolveProfiles(["Alice", "1"], available);
    expect(r.ok && r.profiles).toHaveLength(1);
  });

  it("errors on an unknown profile and says what IS available", () => {
    const r = resolveProfiles(["Nobody"], available);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("Nobody");
    expect(r.error).toContain("Alice (1)");
  });

  it("errors on an id the token cannot write to", () => {
    // An id outside the writable list is not silently attempted — it would only 403.
    expect(resolveProfiles(["99"], available).ok).toBe(false);
  });

  it("refuses an AMBIGUOUS name rather than guessing", () => {
    // Two people can share a name; picking one for the operator is how a document
    // lands on the wrong person.
    const r = resolveProfiles(
      ["Sam"],
      [
        { id: 5, name: "Sam" },
        { id: 6, name: "Sam" },
      ]
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("use the id");
  });
});

describe("exitCodeFor", () => {
  const result = (outcome: UploadResult["outcome"]): UploadResult => ({
    profile: "Alice",
    file: "labs.pdf",
    outcome,
    reason: null,
  });

  it("is 0 when everything stored", () => {
    expect(exitCodeFor([result("stored"), result("stored")])).toBe(0);
  });

  it("is 0 when a file was already there — a duplicate is not a failure", () => {
    // A cron re-scanning the same folder must not go red for doing its job.
    expect(exitCodeFor([result("stored"), result("duplicate")])).toBe(0);
    expect(exitCodeFor([result("duplicate")])).toBe(0);
  });

  it("is 1 when any file failed", () => {
    expect(exitCodeFor([result("stored"), result("failed")])).toBe(1);
  });

  it("is 0 for an empty run", () => {
    expect(exitCodeFor([])).toBe(0);
  });
});

describe("formatResultTable", () => {
  it("prints a header and one row per file × profile", () => {
    const table = formatResultTable([
      { profile: "Alice", file: "labs.pdf", outcome: "stored", reason: null },
      {
        profile: "Bob",
        file: "labs.pdf",
        outcome: "duplicate",
        reason: "Duplicate upload — this file was already uploaded. Skipped.",
      },
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toMatch(/^PROFILE\s+FILE\s+OUTCOME\s+NOTE$/);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Alice");
    expect(lines[1]).toContain("stored");
    expect(lines[2]).toContain("Duplicate upload");
  });

  it("says so when nothing was uploaded", () => {
    expect(formatResultTable([])).toBe("nothing uploaded");
  });
});

describe("contentTypeFor", () => {
  it("maps the common medical-document extensions", () => {
    expect(contentTypeFor("labs.pdf")).toBe("application/pdf");
    expect(contentTypeFor("/a/b/SCAN.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("panel.csv")).toBe("text/csv");
  });

  it("falls back to octet-stream, which the server sniffs past anyway", () => {
    expect(contentTypeFor("mystery")).toBe("application/octet-stream");
    expect(contentTypeFor("notes.weird")).toBe("application/octet-stream");
  });
});
