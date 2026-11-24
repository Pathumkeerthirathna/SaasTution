/*
 * Class-scoped Recorded Lectures (Recorded Lectures redesign, Stage 1: backend).
 *
 * A class's recordings are ordinary RecordedLecture rows on its lectures:
 *  - General Recordings: the recordings of the class's DEFAULT lecture
 *    (Lecture.isDefault = true, the same lecture as General Notes), resolved
 *    on the server from the class; a client-supplied default lecture id is
 *    never accepted (the routes never read one);
 *  - Lecture Recordings: one NORMAL lecture of that class, checked to belong to it.
 *
 * Everything else is the existing teacher recording service and upload
 * protocol (services/recorded-lecture-teacher-service.ts,
 * services/recorded-lecture-upload-service.ts): the same validation, storage
 * quota, upload lifecycle, verification, deletion and preview. The default
 * lecture is only ever let through with an explicit `includeDefault` decided
 * here, never globally.
 */

import { resolveClassLectureForTeacher } from "@/services/class-notes-service";
import { listTeacherLectureRecordings, type TeacherLectureRecordings } from "@/services/recorded-lecture-teacher-service";
import { startRecordingUpload } from "@/services/recorded-lecture-upload-service";

export type ClassRecordingsSection = "GENERAL" | "LECTURE";

export type TeacherClassRecordings = Omit<TeacherLectureRecordings, "lecture"> & {
  class: { id: string; name: string };
  section: ClassRecordingsSection;
  lecture: { id: string; title: string; date: string; isDefault: boolean };
};

/**
 * Teacher: the class's General Recordings (no lectureId) or one normal
 * lecture's recordings. 404 CLASS_NOT_FOUND (not the teacher's active class),
 * 409 DEFAULT_LECTURE_MISSING, 404 LECTURE_NOT_FOUND (another class's,
 * a default or a removed lecture). Same rows and fields as the lecture API.
 */
export async function listClassRecordingsForTeacher(teacherId: string, classId: string, options: { lectureId?: string | null } = {}): Promise<TeacherClassRecordings> {
  const { class: cls, lecture } = await resolveClassLectureForTeacher(teacherId, classId, options.lectureId);
  const list = await listTeacherLectureRecordings({ teacherId, lectureId: lecture.id, includeDefault: lecture.isDefault });
  return {
    ...list,
    class: cls,
    section: lecture.isDefault ? "GENERAL" : "LECTURE",
    lecture: { id: lecture.id, title: lecture.title, date: lecture.date.toISOString(), isDefault: lecture.isDefault },
  };
}

/**
 * Teacher: starts an upload into the class's General Recordings (no
 * lectureId) or into one normal lecture of the class: the existing upload
 * start (startRecordingUpload) with the lecture resolved here. Errors as
 * listClassRecordingsForTeacher, then the upload start's own.
 */
export async function startClassRecordingUpload(input: { teacherId: string; classId: string; lectureId?: string | null; body: unknown }) {
  const { lecture } = await resolveClassLectureForTeacher(input.teacherId, input.classId, input.lectureId);
  return startRecordingUpload({ teacherId: input.teacherId, lectureId: lecture.id, body: input.body, includeDefault: lecture.isDefault });
}
