import { authenticateDevice, refuse } from "@/lib/device-logins";
import { retrieveRecordCitations } from "@/lib/queries";
import { withAiLogContext } from "@/lib/ai-log";
import { answerRecordQuestion } from "@/lib/record-qa-answer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Record Q&A through allos's existing answer path (lib/record-qa-answer.ts): the
// same profile-scoped retrieval and grounded narration the palette's
// askRecordsAction runs, with the same offline degradation when no model is
// configured. Scoped to the resolved profile only.
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateDevice(req, "allos:ask");
  if (!auth.ok) return refuse(auth);
  const question = (new URL(req.url).searchParams.get("q") ?? "")
    .trim()
    .slice(0, 200);
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
