import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const districts = [
  "Ampara",
  "Anuradhapura",
  "Badulla",
  "Batticaloa",
  "Colombo",
  "Galle",
  "Gampaha",
  "Hambantota",
  "Jaffna",
  "Kalutara",
  "Kandy",
  "Kegalle",
  "Kilinochchi",
  "Kurunegala",
  "Mannar",
  "Matale",
  "Matara",
  "Monaragala",
  "Mullaitivu",
  "Nuwara Eliya",
  "Polonnaruwa",
  "Puttalam",
  "Ratnapura",
  "Trincomalee",
  "Vavuniya",
];

async function seedDistricts() {
  console.log("Seeding districts...");

  for (const name of districts) {
    await prisma.district.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  console.log("Done.");
}

seedDistricts()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });