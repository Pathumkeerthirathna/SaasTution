import { redirect } from "next/navigation";

/**
 * /dashboard/recordings: the Recordings group's own address (the collapsed
 * sidebar's group icon links here). Opens its first page, Recorded Lectures.
 */
export default function RecordingsIndexPage() {
  redirect("/dashboard/recordings/recorded-lectures");
}
