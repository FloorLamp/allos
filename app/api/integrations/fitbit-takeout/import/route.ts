import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { requireWriteAccess } from "@/lib/auth";
import { createLogger } from "@/lib/log";
import { importTakeoutArchive } from "@/lib/integrations/fitbit-takeout-import";
import { upsertConnection } from "@/lib/integrations/connections";
import { FITBIT_TAKEOUT_ID } from "@/lib/integrations/fitbit-takeout";

const log = createLogger("fitbit-takeout-route");

// Upload endpoint for a Fitbit Google Takeout archive. Node runtime — it writes to
// disk and opens the file with positional reads.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A Takeout export is far larger than anything else this app accepts: the measured
// one is ~250 MB compressed and Google splits multi-GB accounts into ~2 GB parts. The
// cap is generous BUT real — an unbounded stream-to-disk is a trivial way to fill an
// operator's volume. Overridable for an outlier account.
export const DEFAULT_MAX_TAKEOUT_BYTES = 1024 * 1024 * 1024; // 1 GiB

export function resolveMaxTakeoutBytes(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_TAKEOUT_BYTES;
}

// STREAMED to disk, never buffered. The archive is orders of magnitude larger than
// the 32 MB Health Connect push cap, so holding the body in memory to hand it to the
// parser would defeat the whole selective-read design — the importer then reads the
// file with positional seeks and inflates ~2% of it.
async function streamToFile(
  body: ReadableStream<Uint8Array>,
  dest: string,
  maxBytes: number
): Promise<number> {
  const out = fs.createWriteStream(dest);
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("too-large");
      await new Promise<void>((resolve, reject) =>
        out.write(value, (err) => (err ? reject(err) : resolve()))
      );
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
  return total;
}

export async function POST(req: Request) {
  // The one auth boundary: a write to the ACTIVE profile, same gate as every other
  // ingest write path. `requireWriteAccess` redirects/throws for a member without
  // write access, so nothing below runs unauthorized.
  const { profile } = await requireWriteAccess();
  if (!req.body) {
    return Response.json(
      { ok: false, error: "no file uploaded" },
      { status: 400 }
    );
  }

  // Staged in the OS temp dir, not under data/: it is a transient input, never part
  // of the profile's record, and it must not survive a failed import or end up in a
  // backup. Removed in `finally` whatever happens.
  const staged = path.join(os.tmpdir(), `allos-takeout-${randomUUID()}.zip`);
  try {
    const max = resolveMaxTakeoutBytes(
      process.env.TAKEOUT_MAX_UPLOAD_BYTES ?? undefined
    );
    let bytes: number;
    try {
      bytes = await streamToFile(req.body, staged, max);
    } catch (err) {
      if (err instanceof Error && err.message === "too-large") {
        return Response.json(
          { ok: false, error: "file too large" },
          { status: 413 }
        );
      }
      throw err;
    }
    if (bytes === 0) {
      return Response.json(
        { ok: false, error: "empty upload" },
        { status: 400 }
      );
    }

    const result = importTakeoutArchive(profile.id, staged);
    // An archive kind has nothing to authenticate, but recording the connection
    // gives the Integrations page a "last import" to show and puts this provider in
    // the same status vocabulary as the rest.
    upsertConnection(profile.id, FITBIT_TAKEOUT_ID, { status: "connected" });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    // The generic message is deliberate (#478) — a zip/parse failure must not leak
    // paths or internals to the caller; the cause goes to the error log.
    log.error("takeout import failed", { profileId: profile.id, err });
    return Response.json(
      { ok: false, error: "internal error" },
      { status: 500 }
    );
  } finally {
    try {
      fs.rmSync(staged, { force: true });
    } catch {
      // best-effort cleanup; a leftover temp file must not fail the request
    }
  }
}
