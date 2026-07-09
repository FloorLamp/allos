"use client";

import { useState } from "react";
import { uploadMedicalDocument } from "@/app/(app)/medical/actions";

// Upload form for a medical document. The submit button stays disabled until a
// file is chosen. The file input is a large dashed drop zone for easy drag-drop.
// Two kinds of upload share this one control: a lab report / scan (PDF, image,
// or spreadsheet) that the AI reads, and a portal health-record export — a
// MyChart "Download Summary" (CCD/XDM) or a SMART Health Card — that is parsed
// deterministically into immunizations, labs, and vitals.
export default function UploadForm() {
  const [hasFile, setHasFile] = useState(false);

  return (
    <form action={uploadMedicalDocument} className="mt-4 space-y-4">
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
        accept=".pdf,.xlsx,.csv,image/*,.zip,.xdm,.xml,.smart-health-card,application/zip,text/xml,application/xml,application/json,.json"
        required
        onChange={(e) => setHasFile(!!e.target.files?.length)}
        className="block w-full cursor-pointer rounded-xl border-2 border-dashed border-black/10 bg-slate-50 p-8 text-sm text-slate-500 transition hover:border-brand-400 hover:bg-brand-50 file:mr-4 file:cursor-pointer file:rounded-md file:border-0 file:bg-brand-600 file:px-4 file:py-2 file:font-medium file:text-white hover:file:bg-brand-700 dark:border-white/10 dark:bg-ink-900 dark:text-slate-400 dark:hover:bg-brand-950"
      />
      <button
        className="btn disabled:cursor-not-allowed disabled:opacity-50"
        disabled={!hasFile}
      >
        Upload
      </button>
    </form>
  );
}
