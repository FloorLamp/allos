import { redirect } from "next/navigation";

// Bare group route → its first pane (#1079).
export default function RecordsCarePage() {
  redirect("/records/care/overview");
}
