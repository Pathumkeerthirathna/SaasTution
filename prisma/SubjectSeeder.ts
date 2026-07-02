import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const subjects = [
  // Primary
  "Mathematics",
  "English",
  "Sinhala",
  "Tamil",
  "Environmental Studies",

  // Grades 6-11
  "Science",
  "History",
  "Geography",
  "Health & Physical Education",
  "Civic Education",
  "Buddhism",
  "Catholicism",
  "Christianity",
  "Hinduism",
  "Islam",
  "Information & Communication Technology (ICT)",
  "Art",
  "Music",
  "Drama & Theatre",
  "Dancing",
  "Second Language - Sinhala",
  "Second Language - Tamil",
  "Second Language - English",

  // G.C.E. O/L
  "Commerce",
  "Accounting",
  "Business & Accounting Studies",
  "Entrepreneurship Studies",

  // A/L Science
  "Combined Mathematics",
  "Physics",
  "Chemistry",
  "Biology",
  "Agricultural Science",

  // A/L Commerce
  "Accounting",
  "Business Studies",
  "Economics",

  // A/L Arts
  "Logic & Scientific Method",
  "Political Science",
  "History",
  "Geography",
  "Buddhist Civilization",
  "Sinhala",
  "English Literature",
  "Tamil Literature",
  "Communication & Media Studies",

  // Technology
  "Engineering Technology",
  "Science for Technology",
  "Bio Systems Technology",
  "ICT",

  // Languages
  "Japanese",
  "French",
  "German",
  "Chinese",

  // Other
  "General English"
];

export async function seedSubjects() {
  console.log("Seeding subjects...");

  for (const name of subjects) {
    await prisma.subject.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  console.log(`Seeded ${subjects.length} subjects.`);
}

async function main() {
  await seedSubjects();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });