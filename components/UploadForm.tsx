"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { uploadMedicalDocument } from "@/app/(app)/medical/document-actions";
import { useToast } from "@/components/Toast";
import SubmitButton from "@/components/SubmitButton";
import {
  MEDICAL_UPLOAD_BATCH_CAP,
  MEDICAL_UPLOAD_TOAST_KEY,
} from "@/lib/upload-gate";

// Upload form for medical documents. The submit button stays disabled until at
// least one file is chosen. The file input is a large dashed drop zone for easy
// drag-drop. Two kinds of upload share this one control: a lab report / scan (PDF,
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
// Immediate feedback (issue #102): the inline imports table that used to show a
// processing spinner next to this form moved into Data → Review, so a bare
// `<form action={serverAction}>` left the user staring at nothing after they
// chose a file. We wrap the action instead: the shared SubmitButton spins while
// the upload + background-extraction kickoff runs (useFormStatus), and once it
// returns we (a) clear the file input so re-selecting the SAME file re-fires the
// change event, and (b) toast a confirmation pointing at the Review tab, where
// the unified import feed tracks extraction through to completion.
export default function UploadForm({ demo = false }: { demo?: boolean }) {
  const [selected, setSelected] = useState<File[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const router = useRouter();

  function syncSelected() {
    setSelected(Array.from(inputRef.current?.files ?? []));
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
    const message =
      result.overflow > 0
        ? `${lead} Uploaded the first ${MEDICAL_UPLOAD_BATCH_CAP} files — add the remaining ${result.overflow} in another batch.`
        : lead;
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
      <div
        data-testid="medical-upload-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          if (!demo) setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        className={`rounded-xl transition ${dragActive ? "ring-2 ring-brand-400" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          name="file"
          multiple
          data-testid="medical-upload-input"
          accept=".pdf,.xlsx,.csv,image/*,.zip,.xdm,.xml,.smart-health-card,application/zip,text/xml,application/xml,application/json,.json"
          required
          disabled={demo}
          onChange={syncSelected}
          className="block w-full cursor-pointer rounded-xl border-2 border-dashed border-black/10 bg-slate-50 p-8 text-sm text-slate-500 transition hover:border-brand-400 hover:bg-brand-50 file:mr-4 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:font-medium file:text-white hover:file:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-black/10 disabled:hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400 dark:hover:bg-brand-950"
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
          className="btn disabled:cursor-not-allowed disabled:opacity-50"
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
