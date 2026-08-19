import { IconMicroscope } from "@tabler/icons-react";
import PreventiveReviewControls from "@/components/PreventiveReviewControls";
import { preventiveReviewQuestion } from "@/lib/preventive-review";
import {
  confirmPreventiveRecord,
  dismissPreventiveRecord,
} from "@/app/(app)/upcoming/actions";

// The dashboard atom for one preventive REVIEW CANDIDATE (issue #3025) — the
// Everything-lane rendering of the same fact the Upcoming row shows beside its
// due preventive item (`preventive-review:<recordId>:<ruleKey>`). The candidate
// builder bars it from the Now lane structurally (see
// lib/dashboard-candidates/attention.ts); this card is the go-looking surface.
// The shared controls keep confirm-the-date / dismiss identical on both pages.
export default function PreventiveReviewAtom({
  title,
  recordId,
  ruleKey,
  recordName,
  recordDate,
  today,
  profileId,
  canWrite,
}: {
  // The due preventive item this candidate could resolve, for context.
  title: string;
  recordId: number;
  ruleKey: string;
  recordName: string;
  recordDate: string;
  today: string;
  profileId: number;
  canWrite: boolean;
}) {
  return (
    <article className="card" data-testid="dashboard-preventive-review-atom">
      <div className="flex items-center gap-3">
        <IconMicroscope
          className="h-5 w-5 shrink-0 text-slate-500 dark:text-slate-400"
          stroke={1.75}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-100">
          {title}
        </div>
      </div>
      <div className="mt-2">
        {canWrite ? (
          <PreventiveReviewControls
            confirmAction={async (fd) => {
              "use server";
              return confirmPreventiveRecord(fd);
            }}
            dismissAction={async (fd) => {
              "use server";
              return dismissPreventiveRecord(fd);
            }}
            recordId={recordId}
            ruleKey={ruleKey}
            recordName={recordName}
            recordDate={recordDate}
            question={preventiveReviewQuestion(ruleKey)}
            today={today}
            profileId={profileId}
          />
        ) : (
          <div className="text-xs text-slate-600 dark:text-slate-300">
            {preventiveReviewQuestion(ruleKey)}{" "}
            <span className="font-medium">{recordName}</span>
          </div>
        )}
      </div>
    </article>
  );
}
