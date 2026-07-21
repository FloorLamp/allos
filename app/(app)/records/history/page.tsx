import { redirect } from "next/navigation";

// Bare group route → its first pane (#1079).
export default function RecordsHistoryPage() {
  redirect("/records/history/visits");
}
