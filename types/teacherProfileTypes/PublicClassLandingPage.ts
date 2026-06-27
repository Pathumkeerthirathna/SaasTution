import { ClassSession } from "@prisma/client";
import { ClassBenefit } from "./ClassBenefit";
import { ClassNote } from "./ClassNote";
import { ClassTeacher } from "./ClassTeacher";
import { ClassTestimonial } from "./ClassTestimonial";
import { LearningOutcome } from "./LearningOutcome";
import { PublicClass } from "./PublicClass";
import { RegisterClassInfo } from "./RegisterClassInfo";

export interface PublicClassLandingPage {
  classInfo: PublicClass;

  registerInfo: RegisterClassInfo;

  teacher: ClassTeacher;

  sessions: ClassSession[];

  notes: ClassNote[];

  learningOutcomes: LearningOutcome[];

  benefits: ClassBenefit[];

  testimonials: ClassTestimonial[];
}