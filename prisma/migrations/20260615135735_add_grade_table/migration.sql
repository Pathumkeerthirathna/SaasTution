-- CreateTable
CREATE TABLE "Grade" (
    "id" SERIAL NOT NULL,
    "GradeDesc" TEXT NOT NULL,
    "Status" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Grade_pkey" PRIMARY KEY ("id")
);
