

import { ClassSession } from "@/types/teacherProfileTypes/ClassSession";
import { ClassNote } from "@/types/teacherProfileTypes/ClassNote";
import { LearningOutcome } from "@/types/teacherProfileTypes/LearningOutcome";
import { ClassTestimonial } from "@/types/teacherProfileTypes/ClassTestimonial";
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

export const dummyNotes: ClassNote[] = [
  {
    id: "1",
    title: "Lesson 01 - Introduction to Algebra",
    description:
      "Complete lecture note covering the fundamentals of algebra with worked examples.",
    fileType: "PDF",
    fileSize: "3.4 MB",
    pages: 32,
    preview: true,
  },
  {
    id: "2",
    title: "Lesson 02 - Algebra Workbook",
    description:
      "Practice exercises with step-by-step solutions for algebraic expressions.",
    fileType: "PDF",
    fileSize: "5.8 MB",
    pages: 48,
    preview: true,
  },
  {
    id: "3",
    title: "Lesson 03 - Linear Equations",
    description:
      "Detailed lesson note covering methods for solving linear equations.",
    fileType: "PDF",
    fileSize: "4.6 MB",
    pages: 38,
    preview: false,
  },
  {
    id: "4",
    title: "Lesson 04 - Quadratic Equations",
    description:
      "Theory, worked examples and examination questions on quadratic equations.",
    fileType: "PDF",
    fileSize: "6.9 MB",
    pages: 54,
    preview: false,
  },
  {
    id: "5",
    title: "Geometry Revision Pack",
    description:
      "Revision notes including diagrams, theorems and summary sheets.",
    fileType: "PDF",
    fileSize: "8.3 MB",
    pages: 72,
    preview: false,
  },
  {
    id: "6",
    title: "Statistics Formula Sheet",
    description:
      "Quick reference guide containing important statistical formulas and examples.",
    fileType: "PDF",
    fileSize: "2.1 MB",
    pages: 16,
    preview: false,
  },
  {
    id: "7",
    title: "Assignments & Model Papers",
    description:
      "Collection of assignments and model examination papers with answers.",
    fileType: "ZIP",
    fileSize: "24 MB",
    pages: 110,
    preview: false,
  },
  {
    id: "8",
    title: "Past Papers (2020–2025)",
    description:
      "Official past examination papers with marking schemes and detailed solutions.",
    fileType: "ZIP",
    fileSize: "31 MB",
    pages: 156,
    preview: false,
  },
];


export const dummyLearningOutcomes: LearningOutcome[] = [
  {
    id: "1",
    title: "Master Fundamental Mathematics",
    description:
      "Develop a strong understanding of algebra, geometry, statistics, and number systems through structured lessons.",
  },
  {
    id: "2",
    title: "Improve Problem-Solving Skills",
    description:
      "Learn practical techniques to solve mathematical problems accurately and efficiently in examinations.",
  },
  {
    id: "3",
    title: "Build Examination Confidence",
    description:
      "Gain confidence by practicing model papers, past papers, and teacher-guided revision sessions.",
  },
  {
    id: "4",
    title: "Develop Logical Thinking",
    description:
      "Strengthen analytical and logical reasoning skills by solving real-world mathematical scenarios.",
  },
  {
    id: "5",
    title: "Understand Exam Techniques",
    description:
      "Learn effective time management, answering strategies, and marking scheme expectations for higher scores.",
  },
  {
    id: "6",
    title: "Practice with Quality Resources",
    description:
      "Access professionally prepared notes, assignments, quizzes, and revision materials throughout the course.",
  },
  {
    id: "7",
    title: "Track Continuous Progress",
    description:
      "Measure your improvement through regular assessments, quizzes, and teacher feedback after every lesson.",
  },
  {
    id: "8",
    title: "Achieve Better Examination Results",
    description:
      "Prepare systematically to maximize your performance in school examinations and national assessments.",
  },
];


export const dummyTestimonials: ClassTestimonial[] = [
  {
    id: "1",
    studentName: "Nethmi Perera",
    school: "Ananda Balika College",
    grade: "Grade 10",
    rating: 5,
    comment:
      "This class completely changed the way I understand Mathematics. The teacher explains every lesson clearly, and the revision papers helped me achieve excellent examination results.",
    image:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=400",
    year: "2025 Student",
  },

  {
    id: "2",
    studentName: "Kavindu Silva",
    school: "Royal College",
    grade: "Grade 11",
    rating: 5,
    comment:
      "Excellent explanations, quality notes and continuous teacher support. The recorded lessons allowed me to revise before exams whenever I wanted.",
    image:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=400",
    year: "2024 Student",
  },

  {
    id: "3",
    studentName: "Hasini Fernando",
    school: "Visakha Vidyalaya",
    grade: "Grade 9",
    rating: 5,
    comment:
      "The free preview lessons convinced me to join. Every lesson is well organised and the study materials are excellent.",
    image:
      "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=400",
    year: "2025 Student",
  },

  {
    id: "4",
    studentName: "Dulaj Jayasinghe",
    school: "Nalanda College",
    grade: "Grade 10",
    rating: 5,
    comment:
      "Past paper discussions and assignments greatly improved my confidence. I highly recommend this class to anyone preparing for examinations.",
    image:
      "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=400",
    year: "2025 Student",
  },

  {
    id: "5",
    studentName: "Sanduni Wickramasinghe",
    school: "Musaeus College",
    grade: "Grade 11",
    rating: 5,
    comment:
      "The structured learning plan and teacher guidance helped me improve my mathematics marks within just a few months.",
    image:
      "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=400",
    year: "2024 Student",
  },

  {
    id: "6",
    studentName: "Yasiru Fernando",
    school: "Mahanama College",
    grade: "Grade 10",
    rating: 5,
    comment:
      "Every lesson is engaging and easy to understand. The downloadable notes and recorded sessions are incredibly useful.",
    image:
      "https://images.unsplash.com/photo-1504593811423-6dd665756598?w=400",
    year: "2025 Student",
  },

  {
    id: "7",
    studentName: "Shenali Gunawardena",
    school: "Devi Balika Vidyalaya",
    grade: "Grade 9",
    rating: 5,
    comment:
      "I was initially afraid of Mathematics, but this class made the subject enjoyable. The teacher explains difficult concepts in a simple way.",
    image:
      "https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=400",
    year: "2025 Student",
  },

  {
    id: "8",
    studentName: "Ravindu Senanayake",
    school: "Dharmaraja College",
    grade: "Grade 11",
    rating: 5,
    comment:
      "The combination of live lessons, revision papers and quizzes helped me achieve one of my best Mathematics results.",
    image:
      "https://images.unsplash.com/photo-1504257432389-52343af06ae3?w=400",
    year: "2024 Student",
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