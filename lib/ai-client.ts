// Shared AI plumbing: the model knob used by the medical extractor, the coaching
// insights, and the supplement suggester. (Logging now lives in lib/log.ts.)

// Default to a capable, fast model; override with HEALTH_AI_MODEL.
export const AI_MODEL = process.env.HEALTH_AI_MODEL || "claude-sonnet-4-6";
