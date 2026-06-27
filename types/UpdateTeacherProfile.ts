export interface UpdateTeacherProfile {
  slug?: string;
  designation?: string;
  headline?: string;
  aboutMe?: string;
  qualificationSummary?: string;
  yearsOfExperience?: number;

  phone?: string;
  whatsapp?: string;

  districtId?: number | null;
  cityId?: number | null;

  facebookUrl?: string;
  youtubeUrl?: string;
  tiktokUrl?: string;
  instagramUrl?: string;
  websiteUrl?: string;

  seoTitle?: string;
  seoDescription?: string;

  isPublic?: boolean;
}