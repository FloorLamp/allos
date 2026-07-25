import { redirect } from "next/navigation";

// Bare group route → its first pane (#1079). Problems became a two-pane group in
// #1449, so this joins /records/history and /records/care as a forwarder — every
// existing `/records/problems` link (the /conditions and /allergies 308s, search
// hits, timeline rows, import review) still resolves.
export default function RecordsProblemsPage() {
  redirect("/records/problems/conditions");
}
