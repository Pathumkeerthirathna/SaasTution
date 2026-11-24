export type StudentNavChild = { href: string; label: string };

export type StudentNavItem = {
  href: string;
  label: string;
  icon: string;
  /** When present, an expandable group; its own href is its first page (the collapsed rail's link). */
  children?: StudentNavChild[];
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

/** Anchor of "My Attendance QR" on /student/profile (a plain module, so server pages can link to it). */
export const STUDENT_QR_PANEL_ID = "my-attendance-qr";

// Sidebar: Dashboard, Calendar and My Classes first, then the fixed order below. Teacher Profile and
// My Profile live in the profile menu (studentProfileMenuLinks); Messages in the header's message bell.
export const studentNavItems: StudentNavItem[] = [
  { href: "/student/dashboard",        label: "Dashboard",             icon: "dashboard" },
  { href: "/student/calendar",         label: "Calendar",              icon: "calendar" },
  { href: "/student/classes",          label: "My Classes",            icon: "classes" },
  { href: "/student/notes",            label: "Notes",                 icon: "notes" },
  {
    href: "/student/recorded-lectures",
    label: "Recordings",
    icon: "recordedLectures",
    children: [
      { href: "/student/recorded-lectures", label: "Recorded Lectures" },
      { href: "/student/recordings/live-recordings", label: "Live Recordings" },
      { href: "/student/recordings/youtube-live-sessions", label: "YouTube Live Sessions" },
    ],
  },
  {
    href: "/student/assignments",
    label: "Assignments",
    icon: "assignments",
    children: [
      { href: "/student/assignments", label: "Assignments" },
      { href: "/student/quizzes", label: "Quizzes" },
    ],
  },
  { href: "/student/papers",           label: "Papers",                icon: "papers" },
  { href: "/student/payments",         label: "Payments",              icon: "payments" },
  { href: "/student/material-bundles", label: "Tutes / Papers",        icon: "folder" },
  { href: "/student/lectures",         label: "Lecture / Schedules",   icon: "lectures" },
  { href: "/student/attendance",       label: "Attendance / History",  icon: "attendance" },
  { href: "/student/settings",         label: "Settings",              icon: "settings" },
];

/** The header profile menu's page links (name / avatar), in this order. */
export const studentProfileMenuLinks: StudentNavItem[] = [
  { href: "/student/teacher-profile",  label: "Teacher Profile",       icon: "teacherProfile" },
  { href: "/student/profile",          label: "My Profile",            icon: "profile" },
];

/** Every page the sidebar links to (groups' pages included), for active highlighting. */
export function studentNavHrefs(items: StudentNavItem[] = studentNavItems): string[] {
  return [...new Set(items.flatMap((item) => (item.children ? item.children.map((c) => c.href) : [item.href])))];
}

/**
 * The sidebar page to highlight for a path: the exact page, else the longest
 * page the path is under (/student/recorded-lectures/{id}: Recorded Lectures).
 * Settings also covers /account/security. Pages reached from the header
 * (profile menu, messages) highlight nothing; any other path: Dashboard.
 */
export function studentActiveNavHref(pathname: string | null): string | null {
  if (!pathname) return "/student/dashboard";
  const hrefs = studentNavHrefs();
  if (hrefs.includes(pathname)) return pathname;
  if (pathname.startsWith("/student/settings") || pathname.startsWith("/account/security")) return "/student/settings";
  const under = hrefs.filter((href) => href !== "/student/dashboard" && pathname.startsWith(`${href}/`)).sort((a, b) => b.length - a.length)[0];
  if (under) return under;
  const headerPages = [...studentProfileMenuLinks.map((l) => l.href), "/student/messages"];
  if (headerPages.some((href) => pathname === href || pathname.startsWith(`${href}/`))) return null;
  return "/student/dashboard";
}

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
