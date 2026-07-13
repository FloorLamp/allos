// Shared extraction constants: the model knob and the category/flag whitelists.
import { AI_MODEL } from "../ai-client";
import { MEDICAL_CATEGORIES, MEDICAL_FLAGS } from "../medical-categories";

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
export const CATEGORIES = MEDICAL_CATEGORIES;
export const FLAGS = MEDICAL_FLAGS;
