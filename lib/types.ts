// Re-export barrel for the shared domain types. The definitions are split into
// domain modules under lib/types/* (#319); this file preserves the historical
// `@/lib/types` import surface so callers don't care where a type now lives.
// Every export below keeps its original name.
export * from "./types/training";
export * from "./types/medical";
export * from "./types/intake";
export * from "./types/coaching";
export * from "./types/integrations";
