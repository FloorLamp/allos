import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverNodeBin,
  LEDGER_FILE,
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
    [[durable + "/" + LEDGER_FILE], durable, "the ledger under the durable dir"],
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
      resolveStateDir({ SCRATCH: "/elsewhere" }, io({ exists: (p) => present.has(p) }))
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
