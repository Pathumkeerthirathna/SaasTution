export type StudentNavItem = {
  href: string;
  label: string;
  icon: string;
};

export type LiveClassItem = {
  className: string;
  teacherName: string;
  time: string;
  status: "Live";
  joinLink: string;
};

export type UpcomingClassItem = {
  className: string;
  teacherName: string;
  dateTime: string;
};

export type AssignmentState = "pending" | "completed" | "overdue";

export type AssignmentItem = {
  title: string;
  className: string;
  dueDate: string;
  status: AssignmentState;
};

export type QuizItem = {
  title: string;
  className: string;
  availability: "Available" | "Scheduled" | "Closed";
};

export type LectureNoteItem = {
  title: string;
  type: "Note" | "Supporting Material";
  actionLabel: "View" | "Download";
};

export type AttendanceItem = {
  className: string;
  date: string;
  status: "Present" | "Late" | "Absent";
};

export type AnnouncementItem = {
  from: string;
  title: string;
  content: string;
  sentAt: string;
};

export const studentNavItems: StudentNavItem[] = [
  { href: "/student/dashboard",        label: "Dashboard",             icon: "dashboard" },
  { href: "/student/calendar",         label: "Calendar",              icon: "calendar" },
  { href: "/student/classes",          label: "My Classes",            icon: "classes" },
  { href: "/student/lectures",         label: "Lecture / Schedules",   icon: "lectures" },
  { href: "/student/assignments",      label: "Assignments",           icon: "assignments" },
  { href: "/student/quizzes",          label: "Quizzes",               icon: "quizzes" },
  { href: "/student/papers",           label: "Papers",                icon: "papers" },
  { href: "/student/payments",         label: "Payments",              icon: "payments" },
  { href: "/student/material-bundles", label: "Tutes / Papers",        icon: "folder" },
  { href: "/student/attendance",       label: "Attendance / History",  icon: "attendance" },
  { href: "/student/messages",         label: "Messages",              icon: "messages" },
  { href: "/student/settings",         label: "Settings",              icon: "settings" },
];

export const ongoingClassesSeed: LiveClassItem[] = [
  {
    className: "Advanced Mathematics",
    teacherName: "Guy Russo",
    time: "Today, 10:00 AM - 11:00 AM",
    status: "Live",
    joinLink: "/session/join",
  },
  {
    className: "Physics Fundamentals",
    teacherName: "Sarah Menon",
    time: "Today, 01:00 PM - 02:00 PM",
    status: "Live",
    joinLink: "/session/join",
  },
];

export const upcomingClassesSeed: UpcomingClassItem[] = [
  {
    className: "Chemistry Lab Theory",
    teacherName: "Nuwan Perera",
    dateTime: "Mon, 11:30 AM",
  },
  {
    className: "English Literature",
    teacherName: "Dina Joseph",
    dateTime: "Tue, 09:00 AM",
  },
  {
    className: "Information Technology",
    teacherName: "Ruwan Silva",
    dateTime: "Wed, 03:00 PM",
  },
];

export const assignmentsSeed: AssignmentItem[] = [
  {
    title: "Trigonometry Worksheet",
    className: "Advanced Mathematics",
    dueDate: "May 06, 2026",
    status: "pending",
  },
  {
    title: "Newton Laws Short Report",
    className: "Physics Fundamentals",
    dueDate: "May 04, 2026",
    status: "overdue",
  },
  {
    title: "Poetry Analysis",
    className: "English Literature",
    dueDate: "May 02, 2026",
    status: "completed",
  },
];

export const quizzesSeed: QuizItem[] = [
  {
    title: "Algebra Revision Quiz",
    className: "Advanced Mathematics",
    availability: "Available",
  },
  {
    title: "Atomic Structure Quiz",
    className: "Chemistry Lab Theory",
    availability: "Scheduled",
  },
  {
    title: "IT Basics Quiz",
    className: "Information Technology",
    availability: "Closed",
  },
];

export const lecturesSeed: LectureNoteItem[] = [
  {
    title: "Derivatives and Applications",
    type: "Note",
    actionLabel: "View",
  },
  {
    title: "Lab Safety Guidelines",
    type: "Supporting Material",
    actionLabel: "Download",
  },
  {
    title: "Shakespeare Reference Sheet",
    type: "Note",
    actionLabel: "View",
  },
];

export const historySeed: AttendanceItem[] = [
  {
    className: "Advanced Mathematics",
    date: "May 01, 2026",
    status: "Present",
  },
  {
    className: "Physics Fundamentals",
    date: "Apr 30, 2026",
    status: "Late",
  },
  {
    className: "English Literature",
    date: "Apr 29, 2026",
    status: "Absent",
  },
];

export const announcementsSeed: AnnouncementItem[] = [
  {
    from: "Guy Russo",
    title: "Live revision class today",
    content: "Please join five minutes early. We will cover last week mistakes before starting the quiz review.",
    sentAt: "Today, 08:15 AM",
  },
  {
    from: "Dina Joseph",
    title: "Updated lecture notes uploaded",
    content: "New notes are available under Lectures / Notes. Please review before tomorrow's session.",
    sentAt: "Yesterday, 06:40 PM",
  },
];

export function mapAssignmentTone(status: AssignmentState) {
  if (status === "completed") return "completed" as const;
  if (status === "overdue") return "overdue" as const;
  return "pending" as const;
}

export function mapAttendanceTone(status: AttendanceItem["status"]) {
  if (status === "Present") return "completed" as const;
  if (status === "Late") return "pending" as const;
  return "overdue" as const;
}

export function mapQuizTone(status: QuizItem["availability"]) {
  if (status === "Available") return "completed" as const;
  if (status === "Scheduled") return "pending" as const;
  return "neutral" as const;
}

export function getSummaryStats() {
  const totalClasses = new Set([
    ...ongoingClassesSeed.map((item) => item.className),
    ...upcomingClassesSeed.map((item) => item.className),
  ]).size;

  return {
    totalClasses,
    upcomingClasses: upcomingClassesSeed.length,
    liveClasses: ongoingClassesSeed.length,
    pendingAssignments: assignmentsSeed.filter((item) => item.status === "pending" || item.status === "overdue").length,
    upcomingQuizzes: quizzesSeed.filter((item) => item.availability === "Available" || item.availability === "Scheduled").length,
  };
}
