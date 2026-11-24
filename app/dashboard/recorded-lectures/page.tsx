import { redirect } from "next/navigation";

/**
 * The former Recorded Lectures page: it moved under Recordings
 * (app/dashboard/recordings/recorded-lectures/page.tsx). Bookmarks and old
 * links land there; that page checks the teacher session itself.
 */
export default function FormerRecordedLecturesPage() {
  redirect("/dashboard/recordings/recorded-lectures");
}
