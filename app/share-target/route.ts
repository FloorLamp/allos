import { revalidatePath } from "next/cache";
import { getCurrentSession, accessForProfile } from "@/lib/auth";
import { isDemoMode, isDemoRestricted } from "@/lib/demo";
import { ingestMedicalUpload } from "@/lib/medical-pipeline";
import { MEDICAL_UPLOAD_BATCH_CAP } from "@/lib/upload-gate";
import { dataSectionHref, importHref } from "@/lib/hrefs";
import { createLogger } from "@/lib/log";

// PWA share target (issue #1423). The phone's native share sheet is the idiomatic
// one-tap path for "this lab PDF / this photo of a document belongs in my health
// record": the OS POSTs a multipart/form-data body here (registered by the
// `share_target` entry in app/manifest.ts, under the same `file` field name the
// upload form uses), and this handler hands the file to the ONE ingest engine —
// lib/medical-pipeline::ingestMedicalUpload — that the Data → Import form calls.
//
// NO SECOND INGEST PATH (the import-footprint rule). Per-profile storage, the
// content-hash dedup, the pre-buffer + per-path size gates, the content sniff, the
// audit row, the edit-lock/AI-log semantics and the failed-document rows all come
// free from that shared engine. This route therefore validates only what the engine
// cannot see — that there IS a session, that it may write, and that the multipart
// body actually carried a file — and never re-implements a size or type gate of its
// own (a second copy would drift from the form's).
//
// AUTH. A route handler, not a Server Action, so it authenticates the way the other
// route handlers do: cookie-authoritative getCurrentSession(), never the coarse
// middleware presence check and never requireSession() (which redirect()s, and a
// redirect thrown out of a POST handler is a method-preserving 307). /share-target
// IS on the middleware public allowlist for exactly that reason — see the comment
// in lib/public-paths.ts: the coarse gate would answer an anonymous share with a
// 307 that re-POSTs the file at /login. Here we answer with a 303 instead, which
// the browser follows as a GET, and store NOTHING — the shared file is dropped and
// the user retries after signing in (a stash-and-resume flow is deliberately out of
// scope for v1).
//
// WHICH PROFILE. A share sheet has no way to pick one, so the file lands on the
// session's ACTIVE profile — and we redirect to the stored document's detail page
// (/import/<id>), which is where the explicit "Wrong person?" reassign control
// lives. That makes the profile choice visible and correctable in one tap rather
// than an invisible default.
//
// ERROR SHAPE (#478). Non-redirect failures answer with the JSON `{ ok: false,
// error }` body; the 500 message stays generic (the real cause goes to the server
// error log).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = createLogger("share-target");

// A share is a browser NAVIGATION, so the happy path answers with a redirect the
// browser follows as a GET. 303 (not 307/302) is the point: it must not re-POST the
// multipart body at the destination.
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

export async function POST(req: Request): Promise<Response> {
  const session = await getCurrentSession();
  if (!session) {
    // Nothing is read from the body and nothing is stored. Send the user to the
    // login page pointed at the upload form, so retrying after signing in is one
    // navigation rather than a hunt.
    return seeOther(
      `/login?next=${encodeURIComponent(dataSectionHref("import"))}`
    );
  }
  const { login, profile } = session;

  // Write gate, composed explicitly because the redirecting guards
  // (requireWriteAccess) are wrong for a POST handler. Same two decisions they
  // make: demo mode refuses every non-admin write, and a member acting as a
  // read-only-granted profile may not ingest into it.
  if (
    isDemoRestricted(isDemoMode(), login.role) ||
    accessForProfile(login.id, login.role, profile.id) !== "write"
  ) {
    return Response.json(
      { ok: false, error: "no write access to the active profile" },
      { status: 403 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json(
      { ok: false, error: "expected a multipart/form-data body" },
      { status: 400 }
    );
  }

  // The manifest declares one `files` entry named `file`, but a share sheet may
  // hand over several at once — read them the way the upload form's action does.
  const files = form
    .getAll("file")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length === 0) {
    return Response.json(
      { ok: false, error: "no file was shared" },
      { status: 400 }
    );
  }

  // Sequential + the same soft batch cap as the form: one file body buffered at a
  // time, and a huge multi-select can't swamp the extraction queue.
  const toIngest = files.slice(0, MEDICAL_UPLOAD_BATCH_CAP);
  const landed: number[] = [];
  try {
    for (const file of toIngest) {
      // A share is a HUMAN path, so the engine's two acquirer-only no-row refusals
      // (#1776/#1777) are off and every file lands a row; the null-check is what makes
      // that readable to the type system rather than asserted away.
      const out = await ingestMedicalUpload(login.id, profile.id, file);
      if (out.docId !== null) landed.push(out.docId);
    }
  } catch (err) {
    log.error("share-target ingest failed", {
      profile: profile.id,
      err: err instanceof Error ? err : String(err),
    });
    return Response.json(
      { ok: false, error: "internal error" },
      { status: 500 }
    );
  }
  revalidatePath("/data");

  // One shared file → its stored document (extraction progress, the reason line if
  // the engine rejected it, and the reassign control). Several → the Review feed,
  // which lists them all.
  return seeOther(
    landed.length === 1 ? importHref(landed[0]) : dataSectionHref("review")
  );
}
