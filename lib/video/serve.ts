// Shared byte-serving helper for the video core (#1224) — the app's FIRST
// non-whole-file serve. A <video>/<audio> element scrubs by issuing HTTP Range
// requests, so this honors `Range: bytes=start-end` with a 206 Partial Content +
// Content-Range response and advertises `Accept-Ranges: bytes`; a rangeless GET
// streams the whole file as 200. Both the symptom-video and activity-video serve
// routes (and their `?poster=1` image path) funnel through here, so the range /
// nosniff / streaming behavior is written once.
//
// Node runtime only (fs + streams). Path containment / session + profile scoping
// is the CALLER's job (the route resolves the row `id AND profile_id`, then
// contains the stored path under the domain root) — this helper only turns a
// contained absolute path into a correct byte response.

import fs from "node:fs";
import { Readable } from "node:stream";

// JSON error in the #478 shape (generic on 500). Exported so the routes reuse it.
export function videoJsonError(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

// Parse a single-range `Range` header against a known total size. Returns the
// inclusive [start, end] byte range, or null (serve the whole file). A
// syntactically-invalid or unsatisfiable range returns "invalid" so the caller
// can answer 416.
// Exported for the pure range-math test (lib/__tests__/video-serve.test.ts).
export function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return "invalid";
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return "invalid";
  let start: number;
  let end: number;
  if (rawStart === "") {
    // Suffix range: the last N bytes.
    const n = Number(rawEnd);
    if (n <= 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (Number.isNaN(start) || Number.isNaN(end)) return "invalid";
  if (start > end || start >= size) return "invalid";
  if (end >= size) end = size - 1;
  return { start, end };
}

function webStream(stream: Readable): ReadableStream {
  return Readable.toWeb(stream) as unknown as ReadableStream;
}

// Serve `absPath` as `contentType`, honoring a Range request for scrubbing. The
// caller has already session/profile-scoped and path-contained the file.
export function serveRangedFile(
  req: Request,
  absPath: string,
  contentType: string,
  downloadName: string
): Response {
  let size: number;
  try {
    size = fs.statSync(absPath).size;
  } catch {
    return videoJsonError("file missing", 410);
  }

  const range = parseRange(req.headers.get("range"), size);
  const baseHeaders: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename="${downloadName}"`,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=0, must-revalidate",
  };

  if (range === "invalid") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
    });
  }

  if (range) {
    const chunkSize = range.end - range.start + 1;
    const stream = fs.createReadStream(absPath, {
      start: range.start,
      end: range.end,
    });
    return new Response(webStream(stream), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(chunkSize),
      },
    });
  }

  const stream = fs.createReadStream(absPath);
  return new Response(webStream(stream), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}
