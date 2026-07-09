import fs from "node:fs";
import { DATASETS, toCsv } from "@/lib/export";
import { getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { ZipBuilder } from "@/lib/zip-write";
import { buildFhirBundle } from "@/lib/fhir-export";
import { buildExportManifest } from "@/lib/export-manifest";
import {
  collectFhirExportInput,
  listProfileMedicalFiles,
} from "@/lib/export-full";
import pkg from "@/package.json";

// Node runtime: this streams a ZIP built with fs + the sync SQLite handle; it can't
// run on the Edge.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/export/full — "Export all my data": ONE portable ZIP for the ACTIVE
// profile (issue #18). Contains every owned dataset as JSON + CSV, the clinical
// passport as a FHIR bundle, copies of the profile's medical upload files, and a
// manifest.json table of contents. It is a READ — gated the same way as the
// per-dataset CSV export (cookie-authoritative getCurrentSession, no write gate).
//
// Memory discipline (perf audit #8): the archive is STREAMED entry-by-entry via a
// STORE-only ZIP writer (lib/zip-write) rather than materialized whole. Datasets +
// the FHIR bundle are bounded JSON built in memory, but each medical FILE is read
// and emitted one at a time — the writer only ever holds the current entry.
export async function GET() {
  const session = getCurrentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  const profileId = session.profile.id;
  const profileName = session.profile.name;

  // Audit the full export up front — the request was made and authorized, and this
  // is exactly the "someone took everything" event the log exists to capture.
  recordAudit({
    loginId: session.login.id,
    profileId,
    action: AUDIT_ACTIONS.exportFull,
    target: String(profileId),
  });

  // Lazily produce the archive bytes: each yield is one entry's local header + data
  // (from the ZipBuilder), then the central directory + EOCD at the end.
  function* archive(): Generator<Buffer> {
    const zip = new ZipBuilder();
    const datasetCounts: Record<string, number> = {};

    for (const ds of DATASETS) {
      const rows = ds.rows(profileId);
      datasetCounts[ds.key] = rows.length;
      yield zip.file(
        `datasets/${ds.key}.json`,
        Buffer.from(JSON.stringify(rows, null, 2), "utf8")
      );
      yield zip.file(
        `datasets/${ds.key}.csv`,
        Buffer.from(toCsv(ds.columns, rows), "utf8")
      );
    }

    const fhir = buildFhirBundle(
      collectFhirExportInput(profileId, profileName)
    );
    yield zip.file(
      "passport.fhir.json",
      Buffer.from(JSON.stringify(fhir, null, 2), "utf8")
    );

    const files = listProfileMedicalFiles(profileId);
    for (const f of files) {
      let data: Buffer;
      try {
        data = fs.readFileSync(f.absPath);
      } catch {
        continue; // vanished between listing and read — skip rather than abort
      }
      yield zip.file(f.zipName, data);
    }

    const manifest = buildExportManifest({
      appVersion: pkg.version,
      exportedAt: new Date().toISOString(),
      profile: { id: profileId, name: profileName },
      datasetCounts,
      fileCount: files.length,
      fhirResourceCount: fhir.entry.length,
    });
    yield zip.file(
      "manifest.json",
      Buffer.from(JSON.stringify(manifest, null, 2), "utf8")
    );

    yield zip.end();
  }

  const gen = archive();
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const { value, done } = gen.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(value));
      } catch (err) {
        controller.error(err);
      }
    },
  });

  const date = new Date().toISOString().slice(0, 10);
  const slug =
    profileName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "profile";
  return new Response(stream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="allos-export-${slug}-${date}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
