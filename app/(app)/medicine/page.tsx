import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The former combined Supplements & Medications surface (#746). Supplements folded
// into the Nutrition → Supplements tab and medications became a standalone Medical-
// group page. We REDIRECT rather than 404 on purpose: old Telegram dose/refill
// messages, push payloads, and precached service-worker entries carry `/medicine`
// URLs forever, so a permanent (308) redirect keeps every historical link alive.
// The supplement surface is the natural landing (the medication page is one nav hop
// away). This page sits inside the (app) group, so requireSession() in the layout
// still gates it before the redirect.
export default function MedicineRedirect() {
  permanentRedirect("/nutrition?tab=supplements");
}
