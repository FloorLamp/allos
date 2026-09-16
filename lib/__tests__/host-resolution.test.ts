import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverNodeBin,
  LEDGER_FILE,
  nodePinRefusal,
  nvmrcMajorAt,
  resolveReadToken,
  resolveStateDir,
} from "../../scripts/orchestration/host.mjs";
import { makeTmpDir } from "./tmp-dir";

// HOST RESOLUTION (#3710). The work bootstrap grew up on one Linux
// container and hard-coded its shape — state in /home/user/scratch, node under
// /opt/nvm, a token always in the environment — and a macOS worker has
// none of those. host.mjs is where host variance now lives; these tests pin
// the resolution ORDER, because the order is the compatibility contract:
// existing hosts must keep resolving to exactly what they already use.

const io = (
  over: Partial<{
    exists: (p: string) => boolean;
    homedir: () => string | null;
    tmpdir: () => string;
  }> = {}
) => ({
  exists: () => false,
  homedir: () => "/Users/wang",
  tmpdir: () => "/tmp",
  ...over,
});

describe("resolveStateDir", () => {
  it("SCRATCH wins outright — existing hosts that set it resolve identically", () => {
    expect(resolveStateDir({ SCRATCH: "/somewhere/scratch" }, io())).toBe(
      "/somewhere/scratch"
    );
  });

  it("keeps the live container's layout when its directory exists", () => {
    // The measured live container has SCRATCH unset and its state in
    // /home/user/scratch — moving the default would orphan that state.
    expect(
      resolveStateDir({}, io({ exists: (p) => p === "/home/user/scratch" }))
    ).toBe("/home/user/scratch");
  });

  it("falls to a durable per-user state dir on any other host", () => {
    expect(resolveStateDir({}, io())).toBe(
      "/Users/wang/.local/state/allos-work"
    );
    expect(resolveStateDir({ XDG_STATE_HOME: "/xdg/state" }, io())).toBe(
      "/xdg/state/allos-work"
    );
  });

  it("keeps resolving to a pre-rename allos-orchestration dir that already holds state", () => {
    const legacy = "/Users/wang/.local/state/allos-orchestration";
    expect(resolveStateDir({}, io({ exists: (p) => p === legacy }))).toBe(
      legacy
    );
    // Once the renamed dir exists it wins, whatever the legacy one still holds.
    const current = "/Users/wang/.local/state/allos-work";
    expect(
      resolveStateDir({}, io({ exists: (p) => p === legacy || p === current }))
    ).toBe(current);
  });

  it("uses tmpdir ONLY when no home resolves — the explicit non-durable last resort", () => {
    expect(resolveStateDir({}, io({ homedir: () => null }))).toBe(
      "/tmp/allos-work-state"
    );
  });

  // THE LEDGER'S DIRECTORY STICKS (#5385). Measured 2026-09-06: a session's
  // ledger and roster lived under ~/.local/state, a lane then created
  // /home/user/scratch, and the layout preference flipped every later call to
  // an empty directory — a fresh ledger, a port base re-allocated over a live
  // lane, `list` reading one lane of five. So when BOTH directories exist, the
  // one already holding the ledger wins whatever the layout order says; with
  // no ledger anywhere the documented order is unchanged.
  const container = "/home/user/scratch";
  const durable = "/Users/wang/.local/state/allos-work";
  const legacy = "/Users/wang/.local/state/allos-orchestration";
  it.each([
    [
      [durable + "/" + LEDGER_FILE],
      durable,
      "the ledger under the durable dir",
    ],
    [
      [container + "/" + LEDGER_FILE],
      container,
      "the ledger under the container dir",
    ],
    [[], container, "no ledger anywhere — the layout order stands"],
    [
      [legacy + "/" + LEDGER_FILE],
      legacy,
      "the ledger under the pre-rename dir, even with both newer dirs present",
    ],
  ])(
    "with both directories present resolves to %s → %s (%s)",
    (ledgers, expected) => {
      const present = new Set([container, durable, legacy, ...ledgers]);
      expect(resolveStateDir({}, io({ exists: (p) => present.has(p) }))).toBe(
        expected
      );
    }
  );

  it("SCRATCH still outranks a ledger that lives elsewhere", () => {
    const present = new Set([container, container + "/" + LEDGER_FILE]);
    expect(
      resolveStateDir(
        { SCRATCH: "/elsewhere" },
        io({ exists: (p) => present.has(p) })
      )
    ).toBe("/elsewhere");
  });
});

describe("discoverNodeBin", () => {
  it("takes the RUNNING process first when its major matches", () => {
    const bin = discoverNodeBin("24", {}, io(), {
      version: "v24.7.0",
      execPath: "/hosts/own/bin/node",
    });
    expect(bin).toBe("/hosts/own/bin");
  });

  it("scans version-manager dirs, numerically, when the process does not match", () => {
    const nvm = makeTmpDir("host-nvm");
    const versions = path.join(nvm, "versions", "node");
    // v24.10.0 must beat v24.9.0 — lexical sort gets this backwards.
    for (const v of ["v22.1.0", "v24.9.0", "v24.10.0"]) {
      fs.mkdirSync(path.join(versions, v, "bin"), { recursive: true });
    }
    const bin = discoverNodeBin(
      "24",
      { NVM_DIR: nvm },
      io({ exists: (p) => fs.existsSync(p) }),
      { version: "v22.1.0", execPath: "/elsewhere/bin/node" }
    );
    expect(bin).toBe(path.join(versions, "v24.10.0", "bin"));
  });

  it("answers null, not a guess, when nothing matches the major", () => {
    expect(
      discoverNodeBin("24", {}, io(), {
        version: "v22.1.0",
        execPath: "/x/bin/node",
      })
    ).toBeNull();
  });
});

describe("resolveReadToken", () => {
  it("the environment variables win by name, in the documented order", () => {
    const exec = () => {
      throw new Error("must not be called");
    };
    expect(resolveReadToken({ GH_TOKEN: "env token 1" }, exec)).toBe(
      "env token 1"
    );
    expect(
      resolveReadToken(
        { GH_TOKEN: "env token 1", GITHUB_TOKEN: "env token 2" },
        exec
      )
    ).toBe("env token 1");
    expect(resolveReadToken({ GITHUB_TOKEN: "env token 2" }, exec)).toBe(
      "env token 2"
    );
  });

  it("falls back to `gh auth token` — the read-only credential helper", () => {
    const calls: unknown[] = [];
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return "helper token 1\n";
    };
    expect(resolveReadToken({}, exec as never)).toBe("helper token 1");
    expect(calls).toEqual([["gh", "auth", "token"]]);
  });

  it("answers null when gh is absent or unauthenticated — the refusal stays", () => {
    const throwing = () => {
      throw new Error("gh: command not found");
    };
    expect(resolveReadToken({}, throwing as never)).toBeNull();
    expect(resolveReadToken({}, (() => "\n") as unknown as never)).toBeNull();
  });
});

// THE PINNED MAJOR, READ ONCE (#5940). The read and the parsing used to live
// inside host.mjs's CLI block where nothing could import them, so
// dispatch-brief.mjs kept a second copy and the gate guard would have been a
// third. What is pinned here is the PARSING and the null, not `.nvmrc`'s
// contents: a test that asserted the file says 24 would be the dev-config
// restatement docs/change-policy.md forbids.
describe("nvmrcMajorAt", () => {
  it.each<[string, string | null, string]>([
    ["24\n", "24", "a bare major, as this repo pins it"],
    ["v24.21.0\n", "24", "an nvm-style full version"],
    ["  22  \n", "22", "surrounding whitespace"],
    ["", null, "an empty file — no major, rather than an empty string"],
    ["\n", null, "whitespace only"],
  ])("reads %j as %j (%s)", (text, expected) => {
    expect(nvmrcMajorAt(undefined, () => text)).toBe(expected);
  });

  it("answers null when the read fails, and asks for the ref it was given", () => {
    // A clone that has never fetched origin/main misses ORDINARILY; the caller
    // decides whether to fall back, so this must not throw or invent a major.
    const asked: (string | undefined)[] = [];
    const read = (ref?: string) => {
      asked.push(ref);
      return null;
    };
    expect(nvmrcMajorAt("refs/remotes/origin/main", read)).toBeNull();
    expect(nvmrcMajorAt(undefined, read)).toBeNull();
    expect(asked).toEqual(["refs/remotes/origin/main", undefined]);
  });
});

// THE GATE GUARD'S DECISION (#5940). Its failure mode is PASSING: a run let
// through on the wrong major produces a false red naming an innocent file and
// a false green on a tier that never ran, so the mismatch and the match are
// pinned together. The message is asserted by what an operator must act on —
// both majors and the binary that was actually resolved — not by its wording.
describe("nodePinRefusal", () => {
  const found = {
    pinned: "24",
    at: "at origin/main",
    version: "v22.22.2",
    execPath: "/opt/node22/bin/node",
    bin: "/opt/nvm/versions/node/v24.21.0/bin",
  };

  it("lets the run proceed when the running major IS the pinned one", () => {
    expect(
      nodePinRefusal({ ...found, version: "v24.21.0", execPath: "/x/node" })
    ).toBeNull();
    // Only the MAJOR is pinned; a different patch is the same interpreter.
    expect(
      nodePinRefusal({ ...found, version: "v24.0.0", execPath: "/x/node" })
    ).toBeNull();
  });

  it("refuses a wrong major, naming both versions, the binary and the export", () => {
    const refusal = nodePinRefusal(found);
    expect(refusal).toContain("v22.22.2");
    expect(refusal).toContain("/opt/node22/bin/node");
    expect(refusal).toContain("24");
    expect(refusal).toContain(
      "export PATH=/opt/nvm/versions/node/v24.21.0/bin:$PATH"
    );
  });

  it("says no PATH fixes it when the pinned major is not installed", () => {
    // Prescribing an export over a host that has no such node sends the
    // operator round a loop; the remedy is an install, and it must say so.
    const refusal = nodePinRefusal({ ...found, bin: null });
    expect(refusal).toContain("install");
    expect(refusal).not.toContain("export PATH");
  });

  it("refuses rather than assumes when no .nvmrc could be read at all", () => {
    const refusal = nodePinRefusal({ ...found, pinned: null });
    expect(refusal).toContain("could not be read");
    expect(refusal).toContain("/opt/node22/bin/node");
  });
});
