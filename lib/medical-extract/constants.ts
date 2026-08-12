// Shared extraction constants: the model knob and the category/flag whitelists.
import { AI_MODEL } from "../ai-client";
import {
  ASSIGNABLE_MEDICAL_CATEGORIES,
  MEDICAL_FLAGS,
} from "../medical-categories";

// Shared model knob. Needs a model with PDF + vision support (Claude 3.5+/4).
export const MODEL = AI_MODEL;

// A full lab report can be ~80+ analytes; the structured tool output is large,
// so allow plenty of room. Override with HEALTH_AI_MAX_TOKENS if needed.
export const MAX_TOKENS = Number(process.env.HEALTH_AI_MAX_TOKENS) || 16000;

// The category whitelist and the clinical-flag whitelist come from the single
// shared source (lib/medical-categories.ts) so this extractor and the medical
// write action can't drift. MEDICAL_FLAGS deliberately excludes the DERIVED
// "non-optimal*" flags: those are reconciled in code from the canonical optimal
// band, so the model must never set one (it would contradict that band).
//
// ASSIGNABLE, not the full enum (#2479 part 2): the legacy `biomarker` catch-all is
// retired, so it is neither offered in the tool enum nor accepted from the model. It
// was one of the two paths refilling the bucket migration 185 empties — the prompt
// used to end the category list with "\"biomarker\" only if nothing else fits", which
// is a licence to make no decision. A model that emits it anyway now falls through
// normalizeResults' existing unknown-category default (`lab`), the same treatment any
// other unrecognised string gets.
export const CATEGORIES = ASSIGNABLE_MEDICAL_CATEGORIES;
export const FLAGS = MEDICAL_FLAGS;
