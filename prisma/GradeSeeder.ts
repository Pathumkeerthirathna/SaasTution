import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.grade.createMany({
    data: [
      { GradeDesc: "Grade 1", Status: 1 },
      { GradeDesc: "Grade 2", Status: 1 },
      { GradeDesc: "Grade 3", Status: 1 },
      { GradeDesc: "Grade 4", Status: 1 },
      { GradeDesc: "Grade 5", Status: 1 },
      { GradeDesc: "Grade 6", Status: 1 },
      { GradeDesc: "Grade 7", Status: 1 },
      { GradeDesc: "Grade 8", Status: 1 },
      { GradeDesc: "Grade 9", Status: 1 },
      { GradeDesc: "Grade 10", Status: 1 },
      { GradeDesc: "Grade 11", Status: 1 },
      { GradeDesc: "Grade 12", Status: 1 },
      { GradeDesc: "Grade 13", Status: 1 },
    ],
    skipDuplicates: true,
  });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());