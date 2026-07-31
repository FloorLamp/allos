// Upload medical documents to a remote Allos instance from the command line.
//
//   ALLOS_TOKEN=<token> node scripts/upload-docs.ts --url https://allos.example \
//       --profile alice labs.pdf scans/*.jpg
//
//   ALLOS_TOKEN=<token> npm run upload-docs -- --url https://allos.example \
//       --profile alice --profile 2 labs.pdf
//
//   ALLOS_TOKEN=<token> node scripts/upload-docs.ts --url https://allos.example --list
//
// Options
//   --url <base>        the instance's base URL (required; ALLOS_URL is the fallback)
//   --profile <who>     a profile NAME or id; repeat it to send every file to several
//                       people (required unless --list)
//   --list              print the profiles this token may upload to, and exit
//   --help              this text
//
// The token comes from the ALLOS_TOKEN environment variable and never from argv:
// command lines show up in shell history and in other users' process lists. Mint one at
// Settings → Account & security → API tokens with the "Upload documents" capability.
//
// Exit codes (the scripts/notify.ts convention)
//   0  every file was stored or was already there (a duplicate is not a failure —
//      re-running the same upload is meant to be safe)
//   1  at least one file failed, or the instance could not be reached
//   2  bad arguments
//
// DEPENDENCY-FREE, on purpose. Node 24 stdlib only — `fetch`/`FormData`/`Blob` are
// globals, and Node strips the type annotations. It imports nothing from this repo: no
// database, no schema, no shared modules. So there is no version-skew concern between
// the machine running it and the instance it talks to, and you can copy this ONE file to
// any machine with Node 24 and run it. (Its pure argument/exit-code logic is exported
// and unit-tested from lib/__tests__/upload-docs-cli.test.ts — importing the module must
// therefore never run main(), which is why the entry point is guarded below.)
//
// The endpoint is curl-first; this script is convenience, not protocol:
//
//   curl -H "Authorization: Bearer $ALLOS_TOKEN" -F file=@labs.pdf \
//        "https://allos.example/api/documents?profile=2"

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { pathToFileURL } from "node:url";

// ── Pure argument parsing ────────────────────────────────────────────────────

export interface CliArgs {
  url: string;
  // Names or ids, in the order given. Resolved against the instance later.
  profiles: string[];
  files: string[];
  list: boolean;
  help: boolean;
}

export type ParsedArgs =
  { ok: true; args: CliArgs } | { ok: false; error: string };

// Parse argv (already sliced past node + script). Deliberately strict: an unknown flag
// is an error rather than a filename, because a typo'd `--profil alice` would otherwise
// silently try to upload a file called "alice".
// `env` is typed structurally rather than as NodeJS.ProcessEnv so this file stays
// portable: copied to a machine with no @types/node it still type-checks, and a test can
// pass a bare object without inventing a NODE_ENV.
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {}
): ParsedArgs {
  const args: CliArgs = {
    url: env.ALLOS_URL ?? "",
    profiles: [],
    files: [],
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a === "--list") {
      args.list = true;
    } else if (a === "--url" || a.startsWith("--url=")) {
      const v = a.startsWith("--url=") ? a.slice("--url=".length) : argv[++i];
      if (!v) return { ok: false, error: "--url needs a value" };
      args.url = v;
    } else if (a === "--profile" || a.startsWith("--profile=")) {
      const v = a.startsWith("--profile=")
        ? a.slice("--profile=".length)
        : argv[++i];
      if (!v) return { ok: false, error: "--profile needs a value" };
      args.profiles.push(v);
    } else if (a.startsWith("-")) {
      return { ok: false, error: `unknown option: ${a}` };
    } else {
      args.files.push(a);
    }
  }

  if (args.help) return { ok: true, args };
  if (!args.url) return { ok: false, error: "--url is required" };
  if (args.list) return { ok: true, args };
  if (args.profiles.length === 0) {
    return { ok: false, error: "at least one --profile is required" };
  }
  if (args.files.length === 0) {
    return { ok: false, error: "no files given" };
  }
  return { ok: true, args };
}

// ── Pure outcome → exit code ─────────────────────────────────────────────────

export type Outcome = "stored" | "duplicate" | "failed";

export interface UploadResult {
  profile: string;
  file: string;
  outcome: Outcome;
  reason: string | null;
}

// 0 when everything landed (stored or already present), 1 when anything failed. A
// duplicate is success: a cron that re-scans the same folder must not go red for doing
// its job. Transport errors are recorded as `failed` rows by the caller, so they flow
// through this same rule.
export function exitCodeFor(results: readonly UploadResult[]): 0 | 1 {
  return results.some((r) => r.outcome === "failed") ? 1 : 0;
}

// Render the per-file × per-profile table. Pure so its shape is pinned by a test rather
// than by eyeballing a terminal.
export function formatResultTable(results: readonly UploadResult[]): string {
  if (results.length === 0) return "nothing uploaded";
  const rows = results.map((r) => [
    r.profile,
    r.file,
    r.outcome,
    r.reason ?? "",
  ]);
  const head = ["PROFILE", "FILE", "OUTCOME", "NOTE"];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length))
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

// A best-effort content type from the extension. The server derives the trustworthy MIME
// from the file's magic bytes anyway (and refuses a file whose bytes contradict its
// declared type), so this only spares it an "application/octet-stream" it would have to
// sniff past — exactly what a browser or curl would send.
const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".csv": "text/csv",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".json": "application/json",
  ".zip": "application/zip",
};

export function contentTypeFor(filename: string): string {
  return (
    MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream"
  );
}

// ── Network ──────────────────────────────────────────────────────────────────

interface RemoteProfile {
  id: number;
  name: string;
}

function apiUrl(base: string, path: string): string {
  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function fetchWritableProfiles(
  base: string,
  token: string
): Promise<RemoteProfile[]> {
  const res = await fetch(apiUrl(base, "api/documents/profiles"), {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    profiles?: RemoteProfile[];
    error?: string;
  } | null;
  if (!res.ok || !body?.ok) {
    throw new Error(
      `could not list profiles (HTTP ${res.status}): ${body?.error ?? "no response body"}`
    );
  }
  return body.profiles ?? [];
}

// Resolve each --profile to an id. A bare number is taken as an id, anything else is
// matched against the names the instance returned — case-insensitively and with
// whitespace collapsed, the same normalization the app's own disambiguation uses. An
// ambiguous name is an ERROR, never a guess: two people can share a name, and picking
// one for the operator is how a document lands on the wrong person.
export function resolveProfiles(
  requested: readonly string[],
  available: readonly RemoteProfile[]
): { ok: true; profiles: RemoteProfile[] } | { ok: false; error: string } {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const out: RemoteProfile[] = [];
  for (const want of requested) {
    const byId = /^[1-9][0-9]*$/.test(want.trim())
      ? available.find((p) => p.id === Number(want.trim()))
      : undefined;
    if (byId) {
      if (!out.some((p) => p.id === byId.id)) out.push(byId);
      continue;
    }
    const matches = available.filter((p) => norm(p.name) === norm(want));
    if (matches.length === 0) {
      const names = available.map((p) => `${p.name} (${p.id})`).join(", ");
      return {
        ok: false,
        error: `no writable profile matches "${want}". This token can upload to: ${names || "(none)"}`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        error: `"${want}" matches several profiles (${matches
          .map((p) => p.id)
          .join(", ")}) — use the id`,
      };
    }
    if (!out.some((p) => p.id === matches[0].id)) out.push(matches[0]);
  }
  return { ok: true, profiles: out };
}

async function uploadOne(
  base: string,
  token: string,
  profile: RemoteProfile,
  file: string
): Promise<UploadResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (err) {
    return {
      profile: profile.name,
      file,
      outcome: "failed",
      reason: `could not read file: ${(err as Error).message}`,
    };
  }
  const form = new FormData();
  // Copy into a plain ArrayBuffer-backed view: a Buffer may sit on a pooled/shared
  // allocation, which is not a valid BlobPart.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  form.append(
    "file",
    new Blob([view], { type: contentTypeFor(file) }),
    basename(file)
  );

  let res: Response;
  try {
    res = await fetch(apiUrl(base, `api/documents?profile=${profile.id}`), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
  } catch (err) {
    return {
      profile: profile.name,
      file,
      outcome: "failed",
      reason: `request failed: ${(err as Error).message}`,
    };
  }

  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    documents?: { name: string; outcome: Outcome; reason: string | null }[];
  } | null;
  if (!res.ok || !body?.ok) {
    return {
      profile: profile.name,
      file,
      outcome: "failed",
      reason: `HTTP ${res.status}: ${body?.error ?? "no response body"}`,
    };
  }
  // One file per request, so the engine's per-file verdict is the first (and only) row.
  const doc = body.documents?.[0];
  return {
    profile: profile.name,
    file,
    outcome: doc?.outcome ?? "failed",
    reason: doc?.reason ?? null,
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

const HELP = `upload-docs — send medical documents to an Allos instance

  ALLOS_TOKEN=<token> node scripts/upload-docs.ts --url <base> --profile <who> <files...>

  --url <base>      instance base URL (or set ALLOS_URL)
  --profile <who>   profile name or id; repeat to target several people
  --list            list the profiles this token may upload to
  --help            show this

The token is read from ALLOS_TOKEN, never from the command line.
Exit codes: 0 all stored/duplicate, 1 any failure, 2 bad arguments.`;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), process.env);
  if (!parsed.ok) {
    console.error(`upload-docs: ${parsed.error}\n\n${HELP}`);
    return 2;
  }
  const { args } = parsed;
  if (args.help) {
    console.log(HELP);
    return 0;
  }

  const token = process.env.ALLOS_TOKEN?.trim();
  if (!token) {
    console.error("upload-docs: set ALLOS_TOKEN to an API token\n\n" + HELP);
    return 2;
  }

  let available: RemoteProfile[];
  try {
    available = await fetchWritableProfiles(args.url, token);
  } catch (err) {
    console.error(`upload-docs: ${(err as Error).message}`);
    return 1;
  }

  if (args.list) {
    if (available.length === 0) {
      console.log("this token cannot upload to any profile");
      return 0;
    }
    for (const p of available) console.log(`${p.id}\t${p.name}`);
    return 0;
  }

  const resolved = resolveProfiles(args.profiles, available);
  if (!resolved.ok) {
    console.error(`upload-docs: ${resolved.error}`);
    return 2;
  }

  // Sequential, and one request per (profile, file) pair. Uploading one file to two
  // people is two ingests on purpose: documents are stored and deduped PER PROFILE, so
  // nothing fans out implicitly and each person's copy dedups against their own record.
  const results: UploadResult[] = [];
  for (const profile of resolved.profiles) {
    for (const file of args.files) {
      results.push(await uploadOne(args.url, token, profile, file));
    }
  }

  console.log(formatResultTable(results));
  const code = exitCodeFor(results);
  if (code === 0) {
    console.log(
      "\nExtraction continues on the server — see Data → Review for progress."
    );
  }
  return code;
}

// Run only when invoked directly, so the pure test can import the helpers above without
// firing a network call.
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(
        `upload-docs: ${err instanceof Error ? err.message : String(err)}`
      );
      process.exit(1);
    }
  );
}
