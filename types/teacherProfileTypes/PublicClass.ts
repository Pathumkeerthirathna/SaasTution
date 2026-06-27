import { ClassTeacher } from "./ClassTeacher";

export interface PublicClass {
  id: string;

  slug: string;

  className: string;

  shortDescription: string;

  medium: string;

  monthlyFee: number;

  studentCount: number;

  totalSessions: number;

  duration: string;

  heroImage: string;

  introVideoUrl?: string;

  nextClassDate: string;

  schedule: string;

  teacher: ClassTeacher;
}