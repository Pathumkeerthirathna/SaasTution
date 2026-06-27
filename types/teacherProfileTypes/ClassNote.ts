export interface ClassNote {
  id: string;

  title: string;

  description: string;

  fileType: "PDF" | "DOCX" | "ZIP";

  fileSize: string;

  pages: number;

  preview: boolean;
}