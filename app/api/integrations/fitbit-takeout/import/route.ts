import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { requireWriteAccess } from "@/lib/auth";
import { createLogger } from "@/lib/log";
import {
  FitbitTakeoutWriteError,
  importTakeoutArchive,
} from "@/lib/integrations/fitbit-takeout-import";
import {
  recordSyncEvent,
  upsertConnection,
} from "@/lib/integrations/connections";
import { FITBIT_TAKEOUT_ID } from "@/lib/integrations/fitbit-takeout";
import { SESSION_COOKIE } from "@/lib/session-cookie";
import { ZipIndexError } from "@/lib/zip-index";

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
  // Middleware answers an unauthenticated /api/ request with a 401 JSON — but this
  // route is deliberately OUTSIDE the middleware matcher (see the comment on
  // middleware.ts's config, and lib/__tests__/upload-size-lockstep.test.ts), so it
  // repeats that same coarse cookie-PRESENCE check itself. Without it,
  // requireWriteAccess()'s redirect() turns an unauthenticated XHR into a 307 toward
  // /login, which fetch() silently follows to an HTML page — the client then sees a
  // 200 it can't parse rather than an auth error. This restores the exact prior
  // behavior and is non-authoritative in exactly the same way middleware is: the
  // REAL check is requireWriteAccess() immediately below, which still governs an
  // expired cookie, a member without write access, and demo mode.
  if (!(await cookies()).get(SESSION_COOKIE)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  // The one auth boundary: a write to the ACTIVE profile, same gate as every other
  // ingest write path. `requireWriteAccess` redirects/throws for a member without
  // write access, so nothing below runs unauthorized.
  const { profile } = await requireWriteAccess();
  if (!req.body) {
    recordSyncEvent(profile.id, FITBIT_TAKEOUT_ID, {
      ok: false,
      error: "Takeout import rejected: no archive was uploaded.",
    });
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
        recordSyncEvent(profile.id, FITBIT_TAKEOUT_ID, {
          ok: false,
          error: "Takeout archive exceeded the configured upload limit.",
        });
        return Response.json(
          { ok: false, error: "file too large" },
          { status: 413 }
        );
      }
      throw err;
    }
    if (bytes === 0) {
      recordSyncEvent(profile.id, FITBIT_TAKEOUT_ID, {
        ok: false,
        error: "Takeout import rejected: the uploaded archive was empty.",
      });
      return Response.json(
        { ok: false, error: "empty upload" },
        { status: 400 }
      );
    }

    const result = importTakeoutArchive(profile.id, staged);
    // An archive kind has nothing to authenticate, but recording the connection
    // gives the Integrations page a "last import" to show and puts this source in
    // the same status vocabulary as the rest.
    upsertConnection(profile.id, FITBIT_TAKEOUT_ID, { status: "connected" });
    return Response.json({ ok: true, ...result });
  } catch (err) {
    // An unreadable archive is the CALLER's problem, not a server fault: the wrong
    // zip, a truncated download, a Takeout part that never finished. Answering 500
    // "internal error" told the user nothing and filed a server error for every
    // mistyped upload — and it is what the middleware body-truncation bug looked
    // like from the outside, which is part of why that took so long to see.
    // ZipIndexError messages are authored in lib/zip-index.ts and carry no paths or
    // internals, so they are safe to hand back verbatim under #478.
    if (err instanceof ZipIndexError) {
      log.warn("takeout archive unreadable", {
        profileId: profile.id,
        reason: err.message,
      });
      recordSyncEvent(profile.id, FITBIT_TAKEOUT_ID, {
        ok: false,
        error: err.message,
      });
      return Response.json({ ok: false, error: err.message }, { status: 400 });
    }
    // A chunked write failure already recorded the committed split + provenance in
    // the importer. Every other exception happened before that event boundary, so
    // append one safe, attributable failure instead of letting the attempt vanish.
    if (!(err instanceof FitbitTakeoutWriteError && err.syncEventRecorded)) {
      recordSyncEvent(profile.id, FITBIT_TAKEOUT_ID, {
        ok: false,
        error: "Takeout import failed after the archive was uploaded.",
      });
    }
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
