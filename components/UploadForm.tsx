"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconUpload } from "@tabler/icons-react";
import { uploadMedicalDocument } from "@/app/(app)/medical/document-actions";
import { useToast } from "@/components/Toast";
import SubmitButton from "@/components/SubmitButton";
import PhotoCapture from "@/components/photo/PhotoCapture";
import {
  DOCUMENT_CAPTURE_MAX_EDGE,
  DOCUMENT_CAPTURE_QUALITY,
} from "@/lib/photo/policy";
import {
  MEDICAL_UPLOAD_BATCH_CAP,
  MEDICAL_UPLOAD_TOAST_KEY,
} from "@/lib/upload-gate";

// Upload form for medical documents. The submit button stays disabled until at
// least one file is chosen. One offscreen `name="file"` input is the only picker;
// the affordances OVER it are viewport-shaped — a dashed drop zone on desktop where
// dragging is a real gesture, two equal Upload/Camera buttons on a phone where it
// isn't. Two kinds of upload share this one control: a lab report / scan (PDF,
// image, or spreadsheet) that the AI reads, and a portal health-record export — a
// MyChart "Download Summary" (CCD/XDM) or a SMART Health Card — that is parsed
// deterministically into immunizations, labs, and vitals.
//
// Multi-file (issue #1008): the input is `multiple` and the zone accepts a
// multi-file drop, so a user can hand over a whole stack at once. Every selected
// file rides under the same `file` FormData key; the server action ingests them
// sequentially and enforces a ~20-file soft cap. The chosen files are listed before
// submit, and drops that land on the zone are forwarded into the real input (via a
// DataTransfer) so the form submit carries them.
//
// Camera capture (issues #1423, #1993): a phone can photograph a paper document
// straight into the same submit. It used to render as a label-with-colon plus a bare
// `<input type="file">` under the drop zone — a leftover form field where a second
// way IN belongs, on a viewport where the "drop zone" above it is not a drop zone at
// all. It is now an ACTION: below `sm` the drop zone is gone and the form offers two
// equal buttons, Upload and Camera, the latter opening the shared <PhotoCapture>
// surface. The dual-input mechanism is unchanged and still load-bearing — see the
// comment at the mobile action row.
//
// Immediate feedback (issue #102): the inline imports table that used to show a
// processing spinner next to this form moved into Data → Review, so a bare
// `<form action={serverAction}>` left the user staring at nothing after they
// chose a file. We wrap the action instead: the shared SubmitButton spins while
// the upload + background-extraction kickoff runs (useFormStatus), and once it
// returns we (a) clear the file input so re-selecting the SAME file re-fires the
// change event, and (b) toast a confirmation pointing at the Review tab, where
// the unified import feed tracks extraction through to completion.
//
// Mounted in TWO places since #1525: the Data → File upload tab and the quick-log
// sheet's "Add document" overlay. The overlay is a mount, not a fork — one form, one
// `uploadMedicalDocument` action — and `onUploaded` is the only thing the second mount
// adds: the overlay closes itself once files are actually ingested, so filing a
// document while you were doing something else returns you to what you were doing
// (#1468). The page mount passes nothing and behaves exactly as it always has.
export default function UploadForm({
  demo = false,
  onUploaded,
}: {
  demo?: boolean;
  onUploaded?: () => void;
}) {
  const [selected, setSelected] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const router = useRouter();

  // The preview list and the submit gating read the one real input, which is what
  // every path — picker, drop, camera — writes into.
  function syncSelected() {
    setSelected(Array.from(inputRef.current?.files ?? []));
  }

  // The camera path's landing: APPEND the captured photo to whatever the picker
  // already holds (a photographed page plus a downloaded PDF is one batch) through
  // the same DataTransfer a drop uses, so the form submit carries it with no second
  // field and no second submit. A typed outcome, not an unconditional "done": if the
  // input isn't there the capture modal stays open with the reason.
  async function addCapturedFile(file: File): Promise<string | null> {
    const input = inputRef.current;
    if (!input) return "Couldn't attach the photo. Try again.";
    const dt = new DataTransfer();
    Array.from(input.files ?? []).forEach((f) => dt.items.add(f));
    dt.items.add(file);
    input.files = dt.files;
    syncSelected();
    return null;
  }

  // A drop onto the zone: write the dropped files into the real input (so the form
  // submit carries them) and mirror them into the preview list. preventDefault
  // cancels the input's own native file-drop handling so we stay the single source
  // of truth — the DataTransfer we build is exactly what the input ends up holding.
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragActive(false);
    if (demo) return;
    const dropped = e.dataTransfer.files;
    if (!dropped || dropped.length === 0) return;
    const input = inputRef.current;
    if (input) {
      const dt = new DataTransfer();
      Array.from(dropped).forEach((f) => dt.items.add(f));
      input.files = dt.files;
      syncSelected();
    }
  }

  async function handleUpload(formData: FormData) {
    setError(null);
    let result;
    try {
      result = await uploadMedicalDocument(formData);
    } catch {
      // Size/type failures are handled gracefully server-side as failed-document
      // rows, but a disk-write throw would replace the whole page via the error
      // boundary (issue #477) — keep the form mounted and surface it inline.
      setError("Couldn’t upload the files. Try again.");
      return;
    }
    // Clear the input (and re-disable the button) so the same file(s) can be picked
    // again — a native file input won't re-fire `change` for an identical selection
    // unless it's been reset.
    formRef.current?.reset();
    setSelected([]);
    if (!result || result.ingested === 0) {
      // Nothing valid to ingest (e.g. an empty drop) — hint rather than a silent no-op.
      setError("Choose at least one file to upload.");
      return;
    }
    const lead =
      result.ingested === 1
        ? "Upload received — we’re reading it in the background."
        : `${result.ingested} uploads received — we’re reading them in the background.`;
    const capped =
      result.overflow > 0
        ? `${lead} Uploaded the first ${MEDICAL_UPLOAD_BATCH_CAP} files — add the remaining ${result.overflow} in another batch.`
        : lead;
    // RESTORATION IS NEVER SILENT (#1777). These bytes were deleted before, so a
    // content-hash tombstone was blocking portal re-acquisition of them; uploading the
    // file by hand IS the un-delete, and it also un-blocks the acquirer. Saying so is
    // what keeps the Data → Review blocked list from appearing to lose an entry on its
    // own — and it tells the user the portal may now bring this document back.
    const message =
      result.restored > 0
        ? `${capped} ${
            result.restored === 1
              ? "This document was previously deleted — it's restored, and portal sync can bring it back again."
              : `${result.restored} of these were previously deleted — they're restored, and portal sync can bring them back again.`
          }`
        : capped;
    // Post under the shared lifecycle key (#1315): this confirmation occupies the
    // ONE upload slot, and the headless ExtractionToaster dismisses it and posts the
    // per-document result the moment real extraction output arrives — so the toast
    // upgrades in place instead of the two systems stacking.
    toast(message, {
      key: MEDICAL_UPLOAD_TOAST_KEY,
      action: {
        label: "Track in Review",
        onClick: () => router.push("/data?section=review"),
      },
    });
    // Only after a real ingest — a zero-file submit returned above with its hint, and
    // dismissing the host on an upload that did not happen would be the same lie the
    // typed-outcome rule exists to prevent.
    onUploaded?.();
  }

  return (
    <form ref={formRef} action={handleUpload} className="mt-4 space-y-4">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Drop in a <strong>lab report or scan</strong> (PDF, image, or
        spreadsheet) and the AI reads your results — or a{" "}
        <strong>health-record export</strong> (a MyChart “Download Summary”
        CCD/XDM package, a SMART Health Card, or a FHIR bundle from Epic / Apple
        Health) to import your immunizations, labs, and vitals directly. Missing
        date of birth or sex is filled in from the record. You can select or
        drop <strong>several files at once</strong> (up to{" "}
        {MEDICAL_UPLOAD_BATCH_CAP} per batch).
      </p>
      {/* The ONE real picker, offscreen. Both affordances below drive it, and it is
          the only element carrying `name="file"` — so whatever lands in it (picked,
          dropped, or photographed) rides the same single submit. */}
      <input
        ref={inputRef}
        type="file"
        name="file"
        multiple
        id="medical-upload-file"
        data-testid="medical-upload-input"
        aria-label="Choose files to upload"
        accept=".pdf,.xlsx,.csv,image/*,.zip,.xdm,.xml,.smart-health-card,application/zip,text/xml,application/xml,application/json,.json"
        // Not `required`: the camera path can be the only thing holding a file, and
        // a `required` empty picker would block that submit. The empty case is
        // already gated by the submit button (disabled until something is selected)
        // and answered server-side by the action's zero-file result.
        disabled={demo}
        onChange={syncSelected}
        tabIndex={-1}
        className="sr-only"
      />

      {/* DESKTOP: the drop zone, where drag-and-drop is a real gesture. */}
      <div
        data-testid="medical-upload-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          if (!demo) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`hidden rounded-xl transition sm:block ${dragActive ? "ring-2 ring-brand-400" : ""}`}
      >
        <button
          type="button"
          data-testid="medical-upload-choose"
          disabled={demo}
          onClick={() => inputRef.current?.click()}
          className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-black/10 bg-slate-50 p-8 text-sm text-slate-500 transition hover:border-brand-400 hover:bg-brand-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-black/10 disabled:hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400 dark:hover:bg-brand-950"
        >
          <IconUpload className="h-6 w-6" stroke={1.75} aria-hidden />
          <span>
            <span className="font-medium text-brand-700 dark:text-brand-300">
              Choose files
            </span>{" "}
            or drop them here
          </span>
        </button>
      </div>

      {/* MOBILE: two actions of EQUAL weight (#1993). There is no drag-and-drop on
          touch, so the dashed box above is a desktop metaphor wearing the full
          width of a phone — and the second way in used to hide beneath it as a bare
          file input. On a phone, photographing the page in front of you and picking
          a file out of Drive are equally likely, so they are two buttons.

          The camera is <PhotoCapture>, the photo core's shared capture surface
          (#1119): a live preview with a native-input fallback when getUserMedia is
          unavailable or denied (PWA-safe, CI, older devices), and a canvas
          re-encode that carries no EXIF — a photo of a lab report should not ship
          GPS. Its fallback input is what still carries `capture="environment"`, and
          it is deliberately IMAGE-ONLY and separate from the picker above: a
          `capture` attribute on an input that also accepts PDFs/zips/spreadsheets
          makes mobile Chrome open the camera INSTEAD of the file picker, which
          would take health-record exports off the phone entirely.

          The captured File rides into the real input through the same DataTransfer
          a drop uses, so there is still ONE submit and one `file` field. (The other
          one-tap phone path for a document is the share sheet —
          app/share-target/route.ts.) */}
      <div className="flex gap-3 sm:hidden" data-testid="medical-upload-actions">
        <button
          type="button"
          className="btn flex-1"
          data-testid="medical-upload-choose-mobile"
          disabled={demo}
          onClick={() => inputRef.current?.click()}
        >
          <IconUpload className="h-4 w-4" stroke={1.75} aria-hidden />
          Upload
        </button>
        <PhotoCapture
          triggerLabel="Camera"
          triggerTestId="medical-upload-camera"
          className="btn flex-1"
          disabled={demo}
          maxEdge={DOCUMENT_CAPTURE_MAX_EDGE}
          quality={DOCUMENT_CAPTURE_QUALITY}
          fileName="document.jpg"
          onConfirm={addCapturedFile}
        />
      </div>
      {selected.length > 0 && (
        <ul
          data-testid="medical-upload-selected"
          className="space-y-1 text-sm text-slate-600 dark:text-slate-300"
        >
          {selected.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex justify-between gap-3">
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 tabular-nums text-slate-500 dark:text-slate-400">
                {formatSize(f.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {demo && (
        <p
          data-testid="upload-disabled-hint"
          className="text-sm text-amber-700 dark:text-amber-400"
        >
          File upload is disabled in demo — this is a read-only demo instance.
        </p>
      )}
      {error && (
        <p
          role="alert"
          data-testid="medical-upload-error"
          className="text-sm text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SubmitButton
          disabled={demo || selected.length === 0}
          pendingLabel="Uploading…"
          data-testid="medical-upload-submit"
          className="btn"
        >
          Upload
        </SubmitButton>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          We’ll read {selected.length > 1 ? "them" : "it"} in the background —
          follow progress and results in the{" "}
          <Link
            href="/data?section=review"
            className="font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            Review
          </Link>{" "}
          tab.
        </span>
      </div>
    </form>
  );
}

// Compact human size for the selected-files list (bytes → KB/MB, one decimal).
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}
