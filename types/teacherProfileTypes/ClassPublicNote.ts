export interface ClassPublicNote {
  id: string;

  lectureId: string;

  /** Title of the lecture the note belongs to. */
  lectureTitle: string;

  /** Title given to the note itself. */
  title: string;

  /** Human readable file type badge, e.g. "PDF", "DOCX", "ZIP". */
  fileType: string;

  /** Human readable file size, e.g. "3.4 MB". */
  fileSize: string;

  /** Whether the note can be rendered in the inline PDF viewer. */
  isPdf: boolean;

  /** Whether the note is an image that can be shown in the inline viewer. */
  isImage: boolean;

  /**
   * FREE notes can be previewed without registering. LOCKED notes are shown
   * behind a lock and require enrolment.
   */
  access: "FREE" | "LOCKED";
}
