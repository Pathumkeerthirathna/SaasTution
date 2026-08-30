

import { ClassSession } from "@/types/teacherProfileTypes/ClassSession";
import { RegisterClassInfo } from "@/types/teacherProfileTypes/RegisterClassInfo";
import { ClassBenefit } from "@/types/teacherProfileTypes/ClassBenefit";

// export const dummyTeacher: ClassTeacher = {
//   id: "teacher-001",

//   slug: "pathum-kumara",

//   name: "Pathum Kumara",

//   designation: "Senior Mathematics Teacher",

//   profileImage:
//     "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=600",

//   experience: 8,

//   qualification:
//     "BSc (Hons) Mathematics • University of Colombo",
// };

// export const dummyPublicClass: PublicClass = {
//   id: "class-001",

//   slug: "grade-10-mathematics",

//   className: "Grade 10 Mathematics",

//   shortDescription:
//     "Master Grade 10 Mathematics through structured live classes, HD video recordings, downloadable lecture notes, revision papers, quizzes, and continuous teacher support designed to help students achieve outstanding examination results.",

//   medium: "Sinhala Medium",

//   monthlyFee: 3000,

//   studentCount: 528,

//   totalSessions: 24,

//   duration: "12 Months",

//   nextClassDate: "Saturday, 12 July 2026",

//   schedule: "Every Saturday • 8:00 AM - 10:00 AM",

//   heroImage:
//     "https://images.unsplash.com/photo-1509062522246-3755977927d7?w=1200",

//   introVideoUrl:
//     "https://www.youtube.com/watch?v=dQw4w9WgXcQ",

//   //teacher: {
//     //id: "teacher-001",

//     //slug: "pathum-kumara",

//     //name: "Pathum Kumara",

//     //designation: "Senior Mathematics Teacher",

//     //profileImage:
//       //"https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=600",

//     //qualification:
//       //"BSc (Hons) Mathematics • University of Colombo",

//     //experience: 8,

//     //district: 0,

//     //city: "Maharagama",

//     //totalStudents: 1528,

//     //totalClasses: 12,

//     //isVerified: true,

//     //rating: 4.9,

//     //reviewCount: 348,
//   //},
// };


export const dummySessions: ClassSession[] = [
  {
    id: "1",
    lessonNo: 1,
    title: "Course Introduction & Number Systems",
    description:
      "Introduction to the course structure and a complete overview of number systems with practical examples.",
    duration: "1h 15m",
    preview: true,
  },
  {
    id: "2",
    lessonNo: 2,
    title: "Algebraic Expressions",
    description:
      "Learn algebraic expressions, simplification techniques and solving basic algebraic problems.",
    duration: "1h 40m",
    preview: true,
  },
  {
    id: "3",
    lessonNo: 3,
    title: "Linear Equations",
    description:
      "Master solving one-variable and two-variable linear equations using exam-focused methods.",
    duration: "1h 50m",
    preview: false,
  },
  {
    id: "4",
    lessonNo: 4,
    title: "Quadratic Equations",
    description:
      "Understand quadratic equations, factorization and solving real examination questions.",
    duration: "2h 05m",
    preview: false,
  },
  {
    id: "5",
    lessonNo: 5,
    title: "Geometry Fundamentals",
    description:
      "Learn geometric concepts including triangles, angles and theorems with worked examples.",
    duration: "1h 45m",
    preview: false,
  },
  {
    id: "6",
    lessonNo: 6,
    title: "Statistics & Data Handling",
    description:
      "Introduction to statistical concepts, graphs, averages and data interpretation.",
    duration: "1h 30m",
    preview: false,
  },
  {
    id: "7",
    lessonNo: 7,
    title: "Revision & Model Paper Discussion",
    description:
      "Complete revision session with model paper explanations and examination techniques.",
    duration: "2h 20m",
    preview: false,
  },
  {
    id: "8",
    lessonNo: 8,
    title: "Past Paper Workshop",
    description:
      "Solve previous examination papers step-by-step and understand common marking schemes.",
    duration: "2h 15m",
    preview: false,
  },
];


export const dummyRegisterInfo: RegisterClassInfo = {

  className: "Grade 10 Mathematics",

  monthlyFee: 3000,

  registrationFee: 0,

  duration: "12 Months",

  availableSeats: 18,

  totalStudents: 528,

};


export const dummyBenefits: ClassBenefit[] = [
  {
    id: "1",
    title: "Weekly Live Interactive Classes",
    description:
      "Attend engaging live sessions with real-time explanations and direct interaction with the teacher.",
  },
  {
    id: "2",
    title: "Unlimited HD Video Recordings",
    description:
      "Replay every lesson anytime to revise difficult topics at your own pace.",
  },
  {
    id: "3",
    title: "Professional Lecture Notes",
    description:
      "Download high-quality lesson notes, summaries, and formula sheets for every lesson.",
  },
  {
    id: "4",
    title: "Past Papers & Model Papers",
    description:
      "Practice with carefully selected past papers and model papers including detailed solutions.",
  },
  {
    id: "5",
    title: "Weekly Assignments",
    description:
      "Strengthen your understanding with assignments designed to reinforce every lesson.",
  },
  {
    id: "6",
    title: "Online Quizzes",
    description:
      "Test your knowledge through quizzes and receive instant feedback on your progress.",
  },
  {
    id: "7",
    title: "Teacher Support",
    description:
      "Ask questions whenever you're stuck and receive guidance directly from the teacher.",
  },
  {
    id: "8",
    title: "Continuous Progress Tracking",
    description:
      "Monitor your learning journey with regular assessments and performance reviews.",
  },
  {
    id: "9",
    title: "Future Lesson Updates",
    description:
      "Automatically receive newly uploaded lessons, notes, and revision materials throughout the course.",
  },
  {
    id: "10",
    title: "Exam Success Strategy",
    description:
      "Learn proven examination techniques, time management skills, and answer presentation methods.",
  },
];