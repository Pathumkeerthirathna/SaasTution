-- CreateEnum
CREATE TYPE "Role" AS ENUM ('TEACHER', 'STUDENT', 'GUARDIAN', 'ADMIN');

-- CreateEnum
CREATE TYPE "MessageDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "NoteKind" AS ENUM ('NOTE', 'SUPPORTING_MATERIAL');

-- CreateEnum
CREATE TYPE "Weekday" AS ENUM ('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY');

-- CreateEnum
CREATE TYPE "GradeLevel" AS ENUM ('GRADE_01', 'GRADE_02', 'GRADE_03', 'GRADE_04', 'GRADE_05', 'GRADE_06', 'GRADE_07', 'GRADE_08', 'GRADE_09', 'GRADE_10', 'GRADE_11', 'GRADE_12', 'GRADE_13');

-- CreateEnum
CREATE TYPE "QuizAnswerType" AS ENUM ('SINGLE', 'MULTIPLE');

-- CreateEnum
CREATE TYPE "MaterialBundleStatus" AS ENUM ('DRAFT', 'SENT');

-- CreateEnum
CREATE TYPE "MaterialBundleItemType" AS ENUM ('TUTE', 'PAPER');

-- CreateEnum
CREATE TYPE "ClassPaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'NEEDS_CLARIFICATION');

-- CreateEnum
CREATE TYPE "PaymentMessageSender" AS ENUM ('STUDENT', 'TEACHER');

-- CreateEnum
CREATE TYPE "StudentClassAction" AS ENUM ('ASSIGNED', 'UNASSIGNED');

-- CreateTable
CREATE TABLE "Teacher" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contact" TEXT NOT NULL,
    "registrationNumber" TEXT,
    "grade" "GradeLevel",
    "contact01" TEXT,
    "contact02" TEXT,
    "email" TEXT,
    "password" TEXT,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guardian" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "email" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Guardian_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Class" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "teacherId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schedule" TEXT NOT NULL DEFAULT 'TBD',
    "monthlyFee" INTEGER NOT NULL DEFAULT 0,
    "paymentDueWeek" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Class_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherPaperConfig" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "countdownLeadMinutes" INTEGER NOT NULL DEFAULT 30,
    "submissionGraceMinutes" INTEGER NOT NULL DEFAULT 20,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherPaperConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialBundle" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "MaterialBundleStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "MaterialBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialBundleItem" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "type" "MaterialBundleItemType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "fileName" TEXT,
    "fileUrl" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "paperStartAt" TIMESTAMP(3),
    "paperEndAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaterialBundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperSupportMessage" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperSupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialBundleItemSubmission" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaterialBundleItemSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaterialBundleRecipient" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "willReceive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "MaterialBundleRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassSchedule" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "dayOfWeek" "Weekday" NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassSession" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "roomName" TEXT NOT NULL,
    "jitsiDomain" TEXT NOT NULL DEFAULT 'meet.jit.si',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lectureId" TEXT,

    CONSTRAINT "ClassSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassStudent" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removeReason" TEXT,

    CONSTRAINT "ClassStudent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassStudentHistory" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "action" "StudentClassAction" NOT NULL,
    "actionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "ClassStudentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lecture" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "classId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lecture_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "kind" "NoteKind" NOT NULL DEFAULT 'NOTE',
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "lastDownloadedAt" TIMESTAMP(3),

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "lectureId" TEXT NOT NULL,

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssignmentSubmission" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "notes" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fileName" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,

    CONSTRAINT "AssignmentSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quiz" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lectureId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "maxAttempts" INTEGER,

    CONSTRAINT "Quiz_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizQuestion" (
    "id" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "answerType" "QuizAnswerType" NOT NULL,

    CONSTRAINT "QuizQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizQuestionOption" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isCorrect" BOOLEAN NOT NULL DEFAULT false,
    "orderIndex" INTEGER NOT NULL,

    CONSTRAINT "QuizQuestionOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizSubmission" (
    "id" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "totalQuestions" INTEGER NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "QuizSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuizSubmissionAnswer" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "selectedOptionIds" TEXT[],
    "isCorrect" BOOLEAN NOT NULL,

    CONSTRAINT "QuizSubmissionAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "classSessionId" TEXT NOT NULL,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageDelivery" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassPayment" (
    "id" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "note" TEXT,
    "slipFileName" TEXT,
    "slipFileUrl" TEXT,
    "slipMimeType" TEXT,
    "slipSizeBytes" INTEGER,
    "status" "ClassPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "teacherFeedback" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedByTeacherId" TEXT,

    CONSTRAINT "ClassPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMessage" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "senderRole" "PaymentMessageSender" NOT NULL,
    "studentId" TEXT,
    "teacherId" TEXT,
    "message" TEXT NOT NULL,
    "proofFileName" TEXT,
    "proofFileUrl" TEXT,
    "proofMimeType" TEXT,
    "proofSizeBytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Teacher_email_key" ON "Teacher"("email");

-- CreateIndex
CREATE INDEX "Teacher_createdAt_idx" ON "Teacher"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Student_registrationNumber_key" ON "Student"("registrationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_role_userId_idx" ON "PasswordResetToken"("role", "userId");

-- CreateIndex
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Guardian_email_key" ON "Guardian"("email");

-- CreateIndex
CREATE INDEX "Guardian_studentId_idx" ON "Guardian"("studentId");

-- CreateIndex
CREATE INDEX "Class_teacherId_createdAt_idx" ON "Class"("teacherId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherPaperConfig_teacherId_key" ON "TeacherPaperConfig"("teacherId");

-- CreateIndex
CREATE INDEX "MaterialBundle_classId_year_month_idx" ON "MaterialBundle"("classId", "year", "month");

-- CreateIndex
CREATE INDEX "MaterialBundle_status_sentAt_idx" ON "MaterialBundle"("status", "sentAt");

-- CreateIndex
CREATE INDEX "MaterialBundleItem_bundleId_type_createdAt_idx" ON "MaterialBundleItem"("bundleId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "PaperSupportMessage_itemId_createdAt_idx" ON "PaperSupportMessage"("itemId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperSupportMessage_studentId_createdAt_idx" ON "PaperSupportMessage"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperSupportMessage_teacherId_createdAt_idx" ON "PaperSupportMessage"("teacherId", "createdAt");

-- CreateIndex
CREATE INDEX "PaperSupportMessage_classId_createdAt_idx" ON "PaperSupportMessage"("classId", "createdAt");

-- CreateIndex
CREATE INDEX "MaterialBundleItemSubmission_itemId_studentId_submittedAt_idx" ON "MaterialBundleItemSubmission"("itemId", "studentId", "submittedAt");

-- CreateIndex
CREATE INDEX "MaterialBundleItemSubmission_studentId_submittedAt_idx" ON "MaterialBundleItemSubmission"("studentId", "submittedAt");

-- CreateIndex
CREATE INDEX "MaterialBundleRecipient_studentId_willReceive_idx" ON "MaterialBundleRecipient"("studentId", "willReceive");

-- CreateIndex
CREATE UNIQUE INDEX "MaterialBundleRecipient_bundleId_studentId_key" ON "MaterialBundleRecipient"("bundleId", "studentId");

-- CreateIndex
CREATE INDEX "ClassSchedule_classId_dayOfWeek_idx" ON "ClassSchedule"("classId", "dayOfWeek");

-- CreateIndex
CREATE UNIQUE INDEX "ClassSession_roomName_key" ON "ClassSession"("roomName");

-- CreateIndex
CREATE INDEX "ClassSession_classId_isActive_idx" ON "ClassSession"("classId", "isActive");

-- CreateIndex
CREATE INDEX "ClassSession_classId_isActive_startedAt_idx" ON "ClassSession"("classId", "isActive", "startedAt");

-- CreateIndex
CREATE INDEX "ClassSession_lectureId_startedAt_idx" ON "ClassSession"("lectureId", "startedAt");

-- CreateIndex
CREATE INDEX "ClassStudent_studentId_idx" ON "ClassStudent"("studentId");

-- CreateIndex
CREATE INDEX "ClassStudent_classId_isActive_idx" ON "ClassStudent"("classId", "isActive");

-- CreateIndex
CREATE INDEX "ClassStudentHistory_classId_idx" ON "ClassStudentHistory"("classId");

-- CreateIndex
CREATE INDEX "ClassStudentHistory_studentId_idx" ON "ClassStudentHistory"("studentId");

-- CreateIndex
CREATE INDEX "Lecture_classId_date_idx" ON "Lecture"("classId", "date");

-- CreateIndex
CREATE INDEX "Note_lectureId_idx" ON "Note"("lectureId");

-- CreateIndex
CREATE INDEX "Assignment_lectureId_dueDate_idx" ON "Assignment"("lectureId", "dueDate");

-- CreateIndex
CREATE INDEX "AssignmentSubmission_studentId_idx" ON "AssignmentSubmission"("studentId");

-- CreateIndex
CREATE INDEX "AssignmentSubmission_assignmentId_idx" ON "AssignmentSubmission"("assignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AssignmentSubmission_assignmentId_studentId_key" ON "AssignmentSubmission"("assignmentId", "studentId");

-- CreateIndex
CREATE INDEX "Quiz_lectureId_idx" ON "Quiz"("lectureId");

-- CreateIndex
CREATE INDEX "QuizQuestion_quizId_orderIndex_idx" ON "QuizQuestion"("quizId", "orderIndex");

-- CreateIndex
CREATE INDEX "QuizQuestionOption_questionId_orderIndex_idx" ON "QuizQuestionOption"("questionId", "orderIndex");

-- CreateIndex
CREATE INDEX "QuizSubmission_studentId_idx" ON "QuizSubmission"("studentId");

-- CreateIndex
CREATE INDEX "QuizSubmission_quizId_idx" ON "QuizSubmission"("quizId");

-- CreateIndex
CREATE UNIQUE INDEX "QuizSubmission_quizId_studentId_key" ON "QuizSubmission"("quizId", "studentId");

-- CreateIndex
CREATE INDEX "QuizSubmissionAnswer_questionId_idx" ON "QuizSubmissionAnswer"("questionId");

-- CreateIndex
CREATE UNIQUE INDEX "QuizSubmissionAnswer_submissionId_questionId_key" ON "QuizSubmissionAnswer"("submissionId", "questionId");

-- CreateIndex
CREATE INDEX "Attendance_classId_idx" ON "Attendance"("classId");

-- CreateIndex
CREATE INDEX "Attendance_classId_joinedAt_idx" ON "Attendance"("classId", "joinedAt");

-- CreateIndex
CREATE INDEX "Attendance_classSessionId_idx" ON "Attendance"("classSessionId");

-- CreateIndex
CREATE INDEX "Attendance_classSessionId_joinedAt_idx" ON "Attendance"("classSessionId", "joinedAt");

-- CreateIndex
CREATE INDEX "Attendance_classSessionId_studentId_joinedAt_idx" ON "Attendance"("classSessionId", "studentId", "joinedAt");

-- CreateIndex
CREATE INDEX "Message_classId_createdAt_idx" ON "Message"("classId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageDelivery_messageId_createdAt_idx" ON "MessageDelivery"("messageId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageDelivery_messageId_status_idx" ON "MessageDelivery"("messageId", "status");

-- CreateIndex
CREATE INDEX "MessageDelivery_providerMessageId_idx" ON "MessageDelivery"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageDelivery_messageId_studentId_key" ON "MessageDelivery"("messageId", "studentId");

-- CreateIndex
CREATE INDEX "ClassPayment_studentId_month_idx" ON "ClassPayment"("studentId", "month");

-- CreateIndex
CREATE INDEX "ClassPayment_classId_month_status_idx" ON "ClassPayment"("classId", "month", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ClassPayment_classId_studentId_month_key" ON "ClassPayment"("classId", "studentId", "month");

-- CreateIndex
CREATE INDEX "PaymentMessage_paymentId_createdAt_idx" ON "PaymentMessage"("paymentId", "createdAt");

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guardian" ADD CONSTRAINT "Guardian_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Class" ADD CONSTRAINT "Class_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherPaperConfig" ADD CONSTRAINT "TeacherPaperConfig_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundle" ADD CONSTRAINT "MaterialBundle_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundleItem" ADD CONSTRAINT "MaterialBundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "MaterialBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "MaterialBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MaterialBundleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSupportMessage" ADD CONSTRAINT "PaperSupportMessage_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundleItemSubmission" ADD CONSTRAINT "MaterialBundleItemSubmission_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MaterialBundleItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundleItemSubmission" ADD CONSTRAINT "MaterialBundleItemSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundleRecipient" ADD CONSTRAINT "MaterialBundleRecipient_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "MaterialBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaterialBundleRecipient" ADD CONSTRAINT "MaterialBundleRecipient_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSchedule" ADD CONSTRAINT "ClassSchedule_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassSession" ADD CONSTRAINT "ClassSession_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassStudent" ADD CONSTRAINT "ClassStudent_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassStudent" ADD CONSTRAINT "ClassStudent_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassStudentHistory" ADD CONSTRAINT "ClassStudentHistory_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassStudentHistory" ADD CONSTRAINT "ClassStudentHistory_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lecture" ADD CONSTRAINT "Lecture_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentSubmission" ADD CONSTRAINT "AssignmentSubmission_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "Assignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssignmentSubmission" ADD CONSTRAINT "AssignmentSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quiz" ADD CONSTRAINT "Quiz_lectureId_fkey" FOREIGN KEY ("lectureId") REFERENCES "Lecture"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizQuestion" ADD CONSTRAINT "QuizQuestion_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizQuestionOption" ADD CONSTRAINT "QuizQuestionOption_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizSubmission" ADD CONSTRAINT "QuizSubmission_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizSubmission" ADD CONSTRAINT "QuizSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizSubmissionAnswer" ADD CONSTRAINT "QuizSubmissionAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "QuizQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuizSubmissionAnswer" ADD CONSTRAINT "QuizSubmissionAnswer_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "QuizSubmission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageDelivery" ADD CONSTRAINT "MessageDelivery_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPayment" ADD CONSTRAINT "ClassPayment_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPayment" ADD CONSTRAINT "ClassPayment_confirmedByTeacherId_fkey" FOREIGN KEY ("confirmedByTeacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPayment" ADD CONSTRAINT "ClassPayment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMessage" ADD CONSTRAINT "PaymentMessage_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ClassPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMessage" ADD CONSTRAINT "PaymentMessage_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMessage" ADD CONSTRAINT "PaymentMessage_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE SET NULL ON UPDATE CASCADE;
