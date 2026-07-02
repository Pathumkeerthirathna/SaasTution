export interface TeacherQualification {
    id: string;

    title: string;
    institute: string;

    startYear?: number | null;
    endYear?: number | null;

    displayOrder: number;
}

export interface QualificationForm {
    title: string;
    institute: string;
    startYear?: number | null;
    endYear?: number | null;
    displayOrder: number;
}