export interface TeacherProfile {
  
  // Profile
  profileId: string;
  teacherId: string;
  slug: string;

  profileImageUrl?: string | null;
  coverImageUrl?: string | null;

  designation?: string | null;
  headline?: string | null;
  aboutMe?: string | null;
  qualificationSummary?: string | null;

  yearsOfExperience?: number | null;

  phone?: string | null;
  whatsapp?: string | null;

  districtId?: number | null;
  cityId?: number |null;

  district?: string | null;
  city?: string | null;

  facebookUrl?: string | null;
  youtubeUrl?: string | null;
  instagramUrl?: string | null;
  tiktokUrl?: string | null;
  websiteUrl?: string | null;

  seoTitle?: string | null;
  seoDescription?: string | null;

  isVerified: boolean;
  isPublic: boolean;

  profileViewCount: number;

  createdAt: string;
  updatedAt: string;
  teacher: Teacher;
  mediums: TeacherMedium[];
  
}

export interface Teacher {
  id: string;
  name: string;
  email: string;
}

export interface TeacherMedium {
  id: number;
  name: string;
}

export interface TeacherQualification {

  id: number;
  name: string;
  
}