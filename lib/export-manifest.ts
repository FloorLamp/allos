// Pure builder for the full-account export's manifest.json (issue #18). No DB/FS
// here — the route collects the counts + metadata and hands them in, so the
// manifest shape stays unit-testable and stable. The manifest is the human- and
// machine-readable table of contents a user (or a re-importer) reads first to know
// what the archive holds and where each piece lives.

export interface ExportManifestInput {
  appVersion: string;
  exportedAt: string; // ISO 8601 timestamp
  profile: { id: number; name: string };
  // Per-dataset row counts, keyed by dataset key (activities, body_metrics, …).
  datasetCounts: Record<string, number>;
  // Number of medical upload files bundled under medical-files/.
  fileCount: number;
  // Number of FHIR resources in passport.fhir.json (0 when the passport is empty).
  fhirResourceCount: number;
  // Zip names of files that were listed but vanished from disk before the byte read,
  // so they are ABSENT from the archive — surfaced here instead of silently skipped
  // (#466). Empty/omitted when every listed file was bundled.
  missingFiles?: string[];
  // The bundled profile photo's zip name, when the profile has one on disk (#466).
  profilePhoto?: string | null;
  // The opt-in media bundle (#1846): file count + vanished names when this
  // download opted in; null/omitted when media was not requested (the default),
  // so an archive without a `media` section is one the user chose to keep
  // media-free.
  media?: { count: number; missing?: string[] } | null;
}

export interface ExportManifest {
  app: "allos";
  appVersion: string;
  exportedAt: string;
  profile: { id: number; name: string };
  contents: {
    datasets: { key: string; count: number; json: string; csv: string }[];
    medicalFiles: { directory: string; count: number; missing?: string[] };
    fhir: { file: string; resourceCount: number };
    profilePhoto?: string;
    // Present only when the download opted into the media bundle (#1846).
    media?: {
      directory: string;
      index: string;
      count: number;
      missing?: string[];
    };
    manifest: string;
  };
  totals: {
    datasets: number;
    rows: number;
    files: number;
    // Media files bundled, present ONLY when the download opted in (#1846). Kept
    // separate from `files` rather than folded into it: `files` has always meant
    // "uploaded medical documents", and a reader comparing two archives must be
    // able to see that one of them carries photos and clips.
    mediaFiles?: number;
  };
}

// Assemble the manifest object. `datasetCounts` order is preserved as given (the
// route passes them in DATASETS order), so the manifest lists datasets in the same
// order the archive does.
export function buildExportManifest(
  input: ExportManifestInput
): ExportManifest {
  const datasets = Object.entries(input.datasetCounts).map(([key, count]) => ({
    key,
    count,
    json: `datasets/${key}.json`,
    csv: `datasets/${key}.csv`,
  }));
  const rows = datasets.reduce((sum, d) => sum + d.count, 0);
  const missing = input.missingFiles ?? [];

  return {
    app: "allos",
    appVersion: input.appVersion,
    exportedAt: input.exportedAt,
    profile: input.profile,
    contents: {
      datasets,
      medicalFiles: {
        directory: "medical-files/",
        count: input.fileCount,
        ...(missing.length ? { missing } : {}),
      },
      fhir: {
        file: "passport.fhir.json",
        resourceCount: input.fhirResourceCount,
      },
      ...(input.profilePhoto ? { profilePhoto: input.profilePhoto } : {}),
      ...(input.media
        ? {
            media: {
              directory: "media/",
              index: "media/index.json",
              count: input.media.count,
              ...(input.media.missing?.length
                ? { missing: input.media.missing }
                : {}),
            },
          }
        : {}),
      manifest: "manifest.json",
    },
    totals: {
      datasets: datasets.length,
      rows,
      files: input.fileCount,
      ...(input.media ? { mediaFiles: input.media.count } : {}),
    },
  };
}
