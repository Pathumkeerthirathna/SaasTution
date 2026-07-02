export interface Medium {
  id: number;
  name: string;
}

export interface TeacherMedium {
  id: string;
  profileId: string;
  mediumId: number;
  medium: Medium;
}

export interface UpdateTeacherMediumsRequest {
  mediumIds: number[];
}