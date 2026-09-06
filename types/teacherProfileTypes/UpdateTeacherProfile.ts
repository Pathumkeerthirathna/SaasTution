import { TeacherTitle } from "@prisma/client";

export interface UpdateTeacherProfile {

   name: string;

  slug: string;

  title: TeacherTitle;

  displayName: string;

  designation: string;

  yearsOfExperience: number | null;

  phone: string | null;

  whatsapp: string | null;

  isPublic: boolean;
}