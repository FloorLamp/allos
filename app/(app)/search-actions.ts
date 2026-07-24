"use server";

import { requireSession } from "@/lib/auth";
import { searchAll, retrieveRecordCitations } from "@/lib/queries";
import { withAiLogContext } from "@/lib/ai-log";
import { answerRecordQuestion } from "@/lib/record-qa-answer";
import type { RecordCitation } from "@/lib/record-qa";
import type { SearchGroup } from "@/lib/search-rank";

// Server action behind the Cmd-K palette's debounced fetch. Resolves the active
// profile from the session (requireSession) and searches ONLY that profile's
// data — never a login's other accessible profiles. Read-only.
export async function runGlobalSearch(query: string): Promise<SearchGroup[]> {
  const { profile } = await requireSession();
  return searchAll(profile.id, query);
}

export type AskRecordsResult =
  | {
      ok: true;
      answer: string;
      citations: RecordCitation[];
      offline: boolean;
    }
  | { ok: false; error: string };

// Grounded record Q&A (issue #878, Phase 2). Retrieve the ACTIVE profile's own
// matching rows through the deterministic, profile-scoped seam, then narrate an answer
// grounded in them (with links). Read-only. The retrieval is scoped to the session's
// active profile ONLY — v1 never answers across a login's other accessible profiles
// (cross-profile Q&A is a deliberately deferred, grants-sensitive follow-up). Degrades
// gracefully: keyless, the same retrieved rows come back with an honest offline answer;
// an empty retrieval is a hard "nothing found" refusal (no model call). The AI work is
// wrapped in withAiLogContext so the audit event is tagged with the acting login/profile
// (the AI logs tab stays admin-only).
export async function askRecordsAction(
  formData: FormData
): Promise<AskRecordsResult> {
  const { login, profile } = await requireSession();
  const question = String(formData.get("question") ?? "")
    .trim()
    .slice(0, 200);
  if (!question) return { ok: false, error: "Type a question first." };

  const citations = retrieveRecordCitations(profile.id, question);
  const result = await withAiLogContext(
    { loginId: login.id, profileId: profile.id },
    () => answerRecordQuestion({ question, citations })
  );
  return {
    ok: true,
    answer: result.answer,
    citations: result.citations,
    offline: result.offline,
  };
}
