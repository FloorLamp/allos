// The pure ActivityForm model moved to lib/ (issue #127) so it joins the gated
// lib/** coverage denominator. This shim keeps the historical import path
// (`./model` / `@/components/activity-form/model`) working for the form's
// presentational sub-components — new code should import from
// `@/lib/activity-form-model` directly.
export * from "@/lib/activity-form-model";
