import AddEntryPanel from "@/components/AddEntryPanel";
import { today } from "@/lib/db";
import { getAudiograms, getHearingBaseline } from "@/lib/audiogram-records";
import AudiogramForm from "@/app/(app)/records/specialty/hearing/AudiogramForm";
import AudiogramList from "@/app/(app)/records/specialty/hearing/AudiogramList";
import {
  addAudiogram,
  removeAudiogram,
} from "@/app/(app)/records/specialty/hearing/actions";

// Hearing / audiology (issue #1600) — the sense-organ counterpart to Vision, and the
// domain the app had grown only the PERIPHERY of: ototoxic-drug warnings (#717) and
// hearing-aid equipment (#069) existed, but there was nowhere to record the test they
// both refer to. The profile's dated audiograms: per-ear, per-frequency pure-tone
// thresholds, newest first, with the per-ear average and any documented threshold shift
// since the earliest test on file.
//
// The readings are stored as canonical `vitals` medical_records rows — the SAME
// observation store the perio and vision analytes use, and the same rows that already
// trend on the Biomarkers surface (#713). No parallel table; see lib/audiogram.ts for
// the full store argument.
export default function HearingSection({ profileId }: { profileId: number }) {
  const audiograms = getAudiograms(profileId);
  const baseline = getHearingBaseline(profileId);

  return (
    <div className="space-y-6">
      <AddEntryPanel
        testId="add-audiogram-panel"
        panelId="add-audiogram-panel-body"
        label="Add hearing test"
        presentation="modal"
      >
        <AudiogramForm action={addAudiogram} defaultDate={today(profileId)} />
      </AddEntryPanel>
      <AudiogramList
        audiograms={audiograms}
        baseline={baseline}
        onDelete={removeAudiogram}
      />
      <p className="px-1 text-xs text-slate-500 dark:text-slate-400">
        Thresholds are in dB HL, the audiologist&apos;s scale — lower is better.
        This is a record for you and your audiologist: it transcribes and
        compares measurements, it does not interpret them.
      </p>
    </div>
  );
}
