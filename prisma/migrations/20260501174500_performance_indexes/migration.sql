CREATE INDEX "Teacher_createdAt_idx" ON "Teacher"("createdAt");

CREATE INDEX "Guardian_studentId_idx" ON "Guardian"("studentId");

CREATE INDEX "Class_teacherId_createdAt_idx" ON "Class"("teacherId", "createdAt");

CREATE INDEX "ClassSession_classId_isActive_startedAt_idx"
ON "ClassSession"("classId", "isActive", "startedAt");

CREATE INDEX "ClassStudent_studentId_idx" ON "ClassStudent"("studentId");

CREATE INDEX "Attendance_classSessionId_joinedAt_idx"
ON "Attendance"("classSessionId", "joinedAt");

CREATE INDEX "Message_classId_createdAt_idx" ON "Message"("classId", "createdAt");

CREATE INDEX "MessageDelivery_messageId_createdAt_idx"
ON "MessageDelivery"("messageId", "createdAt");

CREATE INDEX "MessageDelivery_messageId_status_idx"
ON "MessageDelivery"("messageId", "status");
