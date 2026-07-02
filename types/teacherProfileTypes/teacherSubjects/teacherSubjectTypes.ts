export interface Subject {
  id: number;
  name: string;
}

export interface TeacherProfileSubject {
  id: string;

  subjectId: number;

  gradeFrom: number;

  gradeTo: number;

  subject: Subject;
}

export interface SubjectForm {
  subjectId: number;

  gradeFrom: number;

  gradeTo: number;
}

export interface AddTeacherSubjectDto {
  subjectId: number;
  gradeFrom: number;
  gradeTo: number;
}

export interface UpdateTeacherSubjectDto {
  subjectId: number;
  gradeFrom: number;
  gradeTo: number;
}

export interface TeacherSubject {
  id: string;

  subjectId: number;

  gradeFrom: number;

  gradeTo: number;

  subject: {
    id: number;
    name: string;
  };
}