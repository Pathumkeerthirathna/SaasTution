-- CreateTable
CREATE TABLE "TeacherEventType" (
    "id" SERIAL NOT NULL,
    "teacherId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherEventType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeacherCalendarEvent" (
    "id" SERIAL NOT NULL,
    "teacherId" TEXT NOT NULL,
    "eventTypeId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startDateTime" TIMESTAMP(3) NOT NULL,
    "endDateTime" TIMESTAMP(3) NOT NULL,
    "isAllDay" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "meetingUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeacherCalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherEventType_teacherId_idx" ON "TeacherEventType"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "TeacherEventType_teacherId_name_key" ON "TeacherEventType"("teacherId", "name");

-- CreateIndex
CREATE INDEX "TeacherCalendarEvent_teacherId_startDateTime_idx" ON "TeacherCalendarEvent"("teacherId", "startDateTime");

-- CreateIndex
CREATE INDEX "TeacherCalendarEvent_eventTypeId_idx" ON "TeacherCalendarEvent"("eventTypeId");

-- AddForeignKey
ALTER TABLE "TeacherEventType" ADD CONSTRAINT "TeacherEventType_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherCalendarEvent" ADD CONSTRAINT "TeacherCalendarEvent_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherCalendarEvent" ADD CONSTRAINT "TeacherCalendarEvent_eventTypeId_fkey" FOREIGN KEY ("eventTypeId") REFERENCES "TeacherEventType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
