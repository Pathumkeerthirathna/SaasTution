import "server-only";

/*
 * The Recordings > YouTube Live Sessions / Live Recordings pages' server-side
 * selection: the shared teacher class / lecture selection
 * (lib/teacher-class-lecture-selection.ts, also used by the Assignments and
 * Quizzes pages): the signed-in teacher's ACTIVE classes, and the optional
 * ?classId= / ?lectureId= accepted only when they are one of those classes
 * and a NORMAL, active lecture of that class. (A "_lib" folder: not a route.)
 */

export {
  loadTeacherClassLectureSelection as loadYouTubeLectureSelection,
  type TeacherClassLectureSelection as YouTubeLectureSelection,
  type TeacherSelectionClass as YouTubeSelectionClass,
} from "@/lib/teacher-class-lecture-selection";
