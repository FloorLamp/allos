"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconUpload } from "@tabler/icons-react";
import { uploadMedicalDocument } from "@/app/(app)/medical/document-actions";
import { useToast } from "@/components/Toast";
import SubmitButton from "@/components/SubmitButton";
import InlineError from "@/components/InlineError";
import LeadFold from "@/components/LeadFold";
import MediaInput from "@/components/media/MediaInput";
import {
  DOCUMENT_CAPTURE_MAX_EDGE,
  DOCUMENT_CAPTURE_QUALITY,
} from "@/lib/photo/policy";
import {
  MEDICAL_UPLOAD_BATCH_CAP,
  MEDICAL_UPLOAD_TOAST_KEY,
} from "@/lib/upload-gate";

// Upload form for medical documents. The submit button stays disabled until at
// least one file is chosen. Two kinds of upload share this one control: a lab
// report / scan (PDF, image, or spreadsheet) that the AI reads, and a portal
// health-record export — a MyChart "Download Summary" (CCD/XDM) or a SMART
// Health Card — that is parsed deterministically into immunizations, labs, and
// vitals.
//
// THE DOOR IS <MediaInput>, THE SHARED ADD-MEDIA SURFACE (#3286). This form used
// to own its own: an offscreen `name="file"` input under two viewport-shaped
// affordances (a dashed drop zone above `sm`, two equal Upload/Camera buttons
// below it), with a hand-rolled DataTransfer forwarding drops into the input and
// a <PhotoCapture> mount for the camera. All of that MOVED into MediaInput —
// this form is now a consumer of the very drop-zone mechanism it donated, and
// the photo surfaces get it too, which is the point of the consolidation. Gained
// here in the trade: paste-from-clipboard, and a camera path that no longer
// hides behind a `sm:hidden` row.
//
// The dashed zone is this form's `triggerContent`, so dropping a stack of PDFs
// onto the page works exactly as before — MediaInput's trigger is itself a drop
// target — and `name="file"` still lands on ONE real input, MediaInput's, inside
// this <form>. Multi-file (#1008) is `multiple`: every selected file rides the
// same `file` FormData key, the action ingests them sequentially under a ~20-file
// soft cap, and the chosen files are listed before submit.
//
// Camera capture (#1423, #1993): a phone can photograph a paper document straight
// into the same submit. The image presets are the DOCUMENT ones, because a preset
// tuned for skin tone is not tuned for something a downstream extraction has to
// read. MediaInput's picker is image-and-document wide here, and its `capture`
// behaviour is a live viewfinder rather than a `capture` attribute on this input
// — which is what lets one input accept PDFs, zips and spreadsheets without
// mobile Chrome opening the camera INSTEAD of the file picker and taking
// health-record exports off the phone entirely.
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
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const router = useRouter();

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
      {/* LEAD + FOLD (copy.md rule 10 / #3488). The intro used to name CCD/XDM,
          SMART Health Card and FHIR in bold on the first screen — eight lines of
          standards alphabet before either button, on the viewport with the least
          room for it. The formats are not gone; they are one tap away, under the
          question a person would actually ask. Nothing about what the importer
          ACCEPTS changed. */}
      <LeadFold
        testId="upload-intro"
        summary="What can I import?"
        lead={
          <>
            Drop in a lab report, scan, or health-record export — we’ll read it
            for you. Several files at once is fine.
          </>
        }
        detail={
          <>
            A <strong>lab report or scan</strong> (PDF, image, or spreadsheet)
            is read by the AI. A <strong>health-record export</strong> — a
            MyChart “Download Summary” CCD/XDM package, a SMART Health Card, or
            a FHIR bundle from Epic / Apple Health — imports your immunizations,
            labs, and vitals directly. Missing date of birth or sex is filled in
            from the record. Up to {MEDICAL_UPLOAD_BATCH_CAP} files per batch.
          </>
        }
      />
      {/* THE ONE DOOR. Its trigger wears this form's dashed zone, so the desktop
          drop gesture is unchanged; inside, the dialog leads with Choose file on
          a desktop and with the camera on a phone, and takes a drop or a paste
          either way (#3286). `name="file"` makes MediaInput's input this form's
          real field, so there is still ONE submit and one `file` key. */}
      <MediaInput
        name="file"
        multiple
        disabled={demo}
        triggerLabel="Choose files"
        triggerTestId="medical-upload-choose"
        inputTestId="medical-upload-input"
        accept=".pdf,.xlsx,.csv,image/*,.zip,.xdm,.xml,.smart-health-card,application/zip,text/xml,application/xml,application/json,.json"
        maxEdge={DOCUMENT_CAPTURE_MAX_EDGE}
        quality={DOCUMENT_CAPTURE_QUALITY}
        fileName="document.jpg"
        className="flex w-full cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-black/10 bg-slate-50 p-8 text-sm text-slate-500 transition hover:border-brand-400 hover:bg-brand-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-black/10 disabled:hover:bg-slate-50 data-drag-active:border-brand-400 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400 dark:hover:bg-brand-950"
        triggerContent={
          <>
            <IconUpload className="h-6 w-6" stroke={1.75} aria-hidden />
            <span>
              <span className="font-medium text-brand-700 dark:text-brand-300">
                Choose files
              </span>
              {/* Naming the drop gesture on a phone is instructions for a
                  device the reader is not holding. A class, not a branch. */}
              <span className="hidden sm:inline"> or drop them here</span>
            </span>
          </>
        }
        onConfirm={async (files) => {
          // MediaInput has already written these into the real input, so the
          // submit carries them; this list is what the user reads back.
          setSelected(files);
          return null;
        }}
      />
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
      <InlineError data-testid="medical-upload-error">{error}</InlineError>
      {/* THE SUBMIT ROW APPEARS WITH THE FIRST FILE (#3488). It used to render
          always: a permanently disabled "Upload" under a button also called
          "Upload", plus a sentence promising to read "it" in the background when
          there was no "it" — the post-submit explainer shown before there was
          anything to submit. The empty card is now the two doors and nothing
          below them. In demo mode nothing can be selected at all (the picker and
          the input are both disabled), so the row simply never appears and the
          `upload-disabled-hint` above is the whole explanation. */}
      {selected.length > 0 && (
        <div
          data-testid="medical-upload-submit-row"
          className="flex flex-wrap items-center gap-x-3 gap-y-2"
        >
          <SubmitButton
            disabled={demo || selected.length === 0}
            pendingLabel="Uploading…"
            data-testid="medical-upload-submit"
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
      )}
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
