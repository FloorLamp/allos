"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { uploadMedicalDocument } from "@/app/(app)/medical/actions";
import { useToast } from "@/components/Toast";
import SubmitButton from "@/components/SubmitButton";

// Upload form for a medical document. The submit button stays disabled until a
// file is chosen. The file input is a large dashed drop zone for easy drag-drop.
// Two kinds of upload share this one control: a lab report / scan (PDF, image,
// or spreadsheet) that the AI reads, and a portal health-record export — a
// MyChart "Download Summary" (CCD/XDM) or a SMART Health Card — that is parsed
// deterministically into immunizations, labs, and vitals.
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
  const [hasFile, setHasFile] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const router = useRouter();

  async function handleUpload(formData: FormData) {
    await uploadMedicalDocument(formData);
    // Clear the input (and re-disable the button) so the same file can be picked
    // again — a native file input won't re-fire `change` for an identical
    // selection unless it's been reset.
    formRef.current?.reset();
    setHasFile(false);
    toast("Upload received — we’re reading it in the background.", {
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
        date of birth or sex is filled in from the record.
      </p>
      <input
        type="file"
        name="file"
        data-testid="medical-upload-input"
        accept=".pdf,.xlsx,.csv,image/*,.zip,.xdm,.xml,.smart-health-card,application/zip,text/xml,application/xml,application/json,.json"
        required
        disabled={demo}
        onChange={(e) => setHasFile(!!e.target.files?.length)}
        className="block w-full cursor-pointer rounded-xl border-2 border-dashed border-black/10 bg-slate-50 p-8 text-sm text-slate-500 transition hover:border-brand-400 hover:bg-brand-50 file:mr-4 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:font-medium file:text-white hover:file:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-black/10 disabled:hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400 dark:hover:bg-brand-950"
      />
      {demo && (
        <p
          data-testid="upload-disabled-hint"
          className="text-sm text-amber-700 dark:text-amber-400"
        >
          File upload is disabled in demo — this is a read-only demo instance.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SubmitButton
          disabled={demo || !hasFile}
          pendingLabel="Uploading…"
          data-testid="medical-upload-submit"
          className="btn disabled:cursor-not-allowed disabled:opacity-50"
        >
          Upload
        </SubmitButton>
        <span className="text-sm text-slate-500 dark:text-slate-400">
          We’ll read it in the background — follow its progress and results in
          the{" "}
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
