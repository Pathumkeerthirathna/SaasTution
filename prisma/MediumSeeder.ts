import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const mediums = [
  "Sinhala",
  "English",
  "Tamil",
];

export async function seedMediums() {
  console.log("Seeding mediums...");

  for (const name of mediums) {
    await prisma.medium.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  console.log(`Seeded ${mediums.length} mediums.`);
}

async function main() {
  await seedMediums();
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });