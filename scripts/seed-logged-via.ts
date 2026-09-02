// PROVENANCE ON SEEDED ROWS (#3087, #3566).
//
// A seed builds a whole instance out of nothing, so every row it writes has to answer
// the question `logged_via` asks — "which surface did a person use" — on behalf of a
// person who does not exist. This module states the two answers the seeds give, once,
// so the hand-written tranche INSERTs spread across scripts/seed.ts and
// scripts/seed-personas.ts cannot drift apart or quietly stop answering at all.
//
// `page` IS NOT A NEW DECISION. scripts/seed.ts already wraps `saveFitnessEntry` to
// stamp its battery entries `page`, in those words: "seeded demo data stands in for
// somebody logging on the domain page". Every other seeded row now says the same thing
// instead of saying nothing.
//
// A SEEDED ROW WHOSE `source` NAMES AN INTEGRATION IS THE EXCEPTION, and it is the rule
// lib/logged-via.ts already states: `import` is the one value where `source` is the
// authoritative half. A Strava ride or an Oura night in a demo instance was not tapped
// by anybody, and stamping it `page` would claim it was.
//
// THEY ARE SQL LITERALS RATHER THAN BIND PARAMETERS because these statements are
// `db.prepare`d once and re-run many times with positional placeholders; a literal keeps
// the change inside the statement text instead of threading an argument through every
// call site. Both values come from the closed vocabulary in lib/logged-via.ts, so there
// is nothing user-supplied here to escape.
//
// SEEDED `page` ROWS READ AS ENGAGEMENT TO #3077'S RELEVANCE RANKER, AND THAT IS
// DELIBERATE — ruled 2026-09-01 (#3808, question 3). A distinct "seeded" value was
// recommended and overruled: a demo profile's dashboard SHOULD read as lived-in, so
// the ranker consuming fabricated engagement is the behaviour wanted here, not a leak.
// NULL was never neutral either — it was simply unreadable, so this replaces an
// accidental answer with the one somebody chose.

import { IMPORTED, type LoggedVia } from "../lib/logged-via";

/** The surface a seeded row stands in for. */
export const SEEDED_VIA: LoggedVia = "page";

/** `logged_via` for a seeded row that stands in for a person's own entry. */
export const VIA_SEEDED = `'${SEEDED_VIA}'`;

/** `logged_via` for a seeded row whose `source` names an importer or integration. */
export const VIA_IMPORTED = `'${IMPORTED}'`;
