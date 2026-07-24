// Grounded record Q&A — "ask your own records" (issue #878, Phase 2). The posture is
// the same as every AI feature here: RETRIEVE, GROUND, NARRATE — never compute a fact,
// never judge. The deterministic search layer (lib/queries/search.ts) fetches the
// candidate rows for the ACTIVE profile; this module turns that gathered set into a
// numbered citation list, builds a prompt that carries ONLY those rows, and narrates
// an answer that MUST cite them. The model never queries the DB and never answers from
// its own memory: an empty retrieval is a hard "nothing found" refusal, no AI call.
//
// One gather, two renderers (#415), exactly like the explainer (Phase 1): the SAME
// citation set feeds both the AI prompt and the offline structured answer, so a keyless
// instance still shows the grounded rows (with links) and the paid path can never cite
// a row the free path couldn't. Every answer is grounded in typed AppRoute links, so
// "grounded" is literal — each cited row is a real, navigable record.
//
// This module is PURE and CLIENT-SAFE (no SDK, no node:fs): the term extractor, the
// citation assembly, the prompt builder, and the offline composition take data in and
// return data out — no DB, no auth — so the command palette (a client component) can
// import the `RecordCitation` type + `DOMAIN_LABEL` without pulling the AI SDK into the
// browser bundle. The server-only AI narration (`answerRecordQuestion`, which resolves
// an AI client and writes the ai-log) lives in the sibling `lib/record-qa-answer.ts`.
// The DB gather (retrieveRecordCitations) lives in the query layer, profile-scoped like
// every other read; the auth gate stays in the Server Action.

import type { AppRoute } from "./hrefs";
import type { SearchDomain, SearchHit } from "./search-rank";

// One retrieved record, ready to cite. Everything a surface needs to render a linked
// answer: a stable 1-based index the narration cites ([1], [2]…), the display fields,
// and the typed AppRoute the link navigates to. No re-derived facts — these are the
// search hit's OWN fields.
export interface RecordCitation {
  index: number;
  domain: SearchDomain;
  title: string;
  subtitle: string | null;
  date: string | null;
  href: AppRoute;
}

// A short, human label for each record's domain — the badge a citation shows so the
// answer's sources read as "Medication", "Lab result", "Visit", … A closed record here
// keeps it enumerable; a new SearchDomain that reaches Q&A adds its label deliberately.
export const DOMAIN_LABEL: Record<SearchDomain, string> = {
  biomarker: "Lab result",
  document: "Document",
  condition: "Condition",
  allergy: "Allergy",
  procedure: "Procedure",
  immunization: "Immunization",
  encounter: "Visit",
  appointment: "Appointment",
  activity: "Activity",
  supplement: "Supplement or medication",
  "family-history": "Family history",
  "care-plan": "Care plan",
  "care-goal": "Care goal",
  goal: "Goal",
  page: "Page",
};

// The retrieval CAP: how many candidate rows can reach the prompt/answer. Personal-app
// scale — a bounded set keeps the Q&A on the Light tier (no long-context blow-up) and
// keeps the answer's citation list legible. Over-retrieval is trimmed, most-relevant
// first (the search ranker already ordered the hits).
export const MAX_CITATIONS = 12;

// Words that carry no record signal — question scaffolding and generic verbs. Dropping
// them keeps the deterministic search from matching on "last"/"take"/"have" noise, so
// "when did I last take antibiotics?" retrieves on "antibiotics" alone. Deliberately
// small and generic (never a domain term).
const STOPWORDS = new Set<string>([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "with",
  "my",
  "our",
  "her",
  "his",
  "their",
  "she",
  "he",
  "they",
  "i",
  "we",
  "you",
  "me",
  "us",
  "did",
  "do",
  "does",
  "is",
  "are",
  "was",
  "were",
  "am",
  "be",
  "been",
  "have",
  "has",
  "had",
  "get",
  "got",
  "take",
  "taken",
  "took",
  "taking",
  "when",
  "what",
  "which",
  "who",
  "how",
  "why",
  "where",
  "last",
  "first",
  "recent",
  "recently",
  "ago",
  "any",
  "some",
  "all",
  "many",
  "much",
  "there",
  "about",
  "show",
  "tell",
  "list",
  "give",
  "compare",
  "than",
  "then",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "over",
  "since",
  "from",
  "until",
]);

// The max distinct search terms a question expands to — bounds the DB fan-out (each
// term runs the full per-domain search).
const MAX_TERMS = 6;

// Extract the salient search terms from a natural-language question — PURE. Lowercase,
// split on non-word runs, drop stopwords and 1-2 char fragments, dedupe, and cap. This
// is the deterministic seam: the model NEVER picks what to retrieve; these terms drive
// the same profile-scoped search every other surface uses.
export function extractQueryTerms(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of question.toLowerCase().split(/[^a-z0-9]+/)) {
    const term = raw.trim();
    if (term.length < 3) continue;
    if (STOPWORDS.has(term)) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

// Turn the gathered, de-duplicated search hits into a numbered citation set — PURE.
// Caps at MAX_CITATIONS (the ranker ordered them, so the cut keeps the best) and
// assigns each a stable 1-based index the narration cites. Pages are not records, so a
// caller filters them out before this; this just numbers whatever it's handed.
export function buildRetrievalSet(
  hits: readonly SearchHit[]
): RecordCitation[] {
  return hits.slice(0, MAX_CITATIONS).map((h, i) => ({
    index: i + 1,
    domain: h.domain,
    title: h.title,
    subtitle: h.subtitle,
    date: h.date,
    href: h.href,
  }));
}

// One citation rendered as a prompt line: "[1] Amoxicillin — Active (2026-03-04)
// [Supplement or medication]". Only the row's OWN fields; nothing computed.
function citationLine(c: RecordCitation): string {
  const bits = [c.subtitle, c.date].filter((b) => b && String(b).trim());
  const tail = bits.length ? ` — ${bits.join(" · ")}` : "";
  return `[${c.index}] ${c.title}${tail} (${DOMAIN_LABEL[c.domain]})`;
}

export const ASK_SYSTEM = `You answer questions about a person's OWN health records, and you may ONLY use the records handed to you. You are a retrieval front-end, not a clinician.

Hard rules:
- Use ONLY the numbered records provided. Never introduce a fact, date, value, diagnosis, or medication that is not in them.
- Cite the records you use by their number in square brackets, e.g. [1], [2].
- If the records do not answer the question, reply with EXACTLY: Nothing found in your records.
- Never give medical advice, never interpret a result, never judge a trend. State only what the records themselves say, with the citation.
- Be brief: 1-3 short sentences. No hedging, no reassurance, no alarm.`;

// Build the grounded prompt from ONLY the question + the retrieved citations — PURE.
// There is nowhere for an un-retrieved fact to enter: the model sees the question and
// the numbered rows, nothing else.
export function buildAskPrompt(
  question: string,
  citations: readonly RecordCitation[]
): string {
  const lines = [`Question: ${question.trim()}`, "", "The person's records:"];
  for (const c of citations) lines.push(citationLine(c));
  lines.push(
    "",
    "Answer the question using ONLY these records, citing each one you use by its number. If they do not answer it, reply exactly: Nothing found in your records."
  );
  return lines.join("\n");
}

// The offline / degraded answer — PURE. When retrieval is EMPTY, the deterministic
// refusal ("Nothing found…") — never a speculation. When there ARE rows but no AI tier
// is configured, an honest structured intro; the surface renders the citation LINKS
// itself, so the grounded rows are still reachable without the model.
export function composeOfflineAnswer(
  question: string,
  citations: readonly RecordCitation[]
): string {
  if (citations.length === 0) {
    return "Nothing found in your records.";
  }
  const noun = citations.length === 1 ? "record" : "records";
  return `Found ${citations.length} matching ${noun} (AI narration is off — the matching records are linked below).`;
}

export interface AskInput {
  question: string;
  citations: RecordCitation[];
}

export interface AskResult {
  answer: string;
  // The rows the answer is grounded in — always returned so the surface can render the
  // links, whether the text came from the model or the offline composition.
  citations: RecordCitation[];
  // Whether the answer came from the offline composition (no model) vs the AI narration.
  offline: boolean;
  model?: string;
}
