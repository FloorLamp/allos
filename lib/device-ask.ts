import type { DeviceAuth } from "./device-logins";
import { retrieveRecordCitations } from "./queries";
import { withAiLogContext } from "./ai-log";
import { answerRecordQuestion } from "./record-qa-answer";

// Record Q&A for the device API and its session twin (app/v1/ask, app/api/ask): the
// same profile-scoped retrieval and grounded narration the palette's askRecordsAction
// runs, with the same offline degradation when no model is configured. Scoped to the
// resolved profile only. The caller has authenticated; this only answers.
export async function askRecords(
  auth: DeviceAuth & { ok: true },
  raw: string
): Promise<Response> {
  const question = raw.trim().slice(0, 200);
  if (!question) return Response.json({ error: "q" }, { status: 400 });
  const { login, profile } = auth;
  const citations = retrieveRecordCitations(profile.id, question, login.id);
  const result = await withAiLogContext(
    { loginId: login.id, profileId: profile.id },
    () => answerRecordQuestion({ question, citations })
  );
  return Response.json(
    {
      profile: profile.id,
      answer: result.answer,
      offline: result.offline,
      citations: result.citations.map((c) => ({
        index: c.index,
        kind: c.domain,
        ...(c.loggedKind ? { loggedKind: c.loggedKind } : {}),
        title: c.title,
        subtitle: c.subtitle,
        date: c.date,
        href: c.href,
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
