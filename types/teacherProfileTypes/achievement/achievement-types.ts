export interface Achievement {
  id: string;

  profileId: string;

  title: string;

  description: string | null;

  year: number | null;

  imageUrl?: string | null;

  displayOrder: number;

  createdAt: string;

  updatedAt: string;
}

export interface AchievementForm {
  title: string;

  description: string;

  year: number | "";

  photo?: File | null;

  removePhoto?: boolean;
}