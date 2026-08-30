export const MAX_TEACHER_ANNOUNCEMENTS = 5;

export interface TeacherAnnouncement {
  id: string;

  teacherId: string;

  /** Stored file name of the announcement image, e.g. "pathum-kumara-Post01.png". */
  imageName: string;

  /** URL the client can use to render the image. */
  imageUrl: string;

  description: string;

  sortOrder: number;

  createdAt: string;

  updatedAt: string;
}

export interface AnnouncementForm {
  description: string;

  /** New image file selected in the drawer. Required when creating, optional when editing. */
  imageFile: File | null;
}
