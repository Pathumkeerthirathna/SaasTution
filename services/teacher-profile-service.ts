import type { TeachingLevel } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AddAchievement } from "@/types/AddAchievement";
import { AddQualification } from "@/types/AddQualification";
import { TeacherProfile } from "@/types/teacherProfileTypes/ClassTeacher";
import { UpdateSocialLinks } from "@/types/teacherProfileTypes/SocialLink/types";
import { UpdateTeacherProfile } from "@/types/teacherProfileTypes/UpdateTeacherProfile";
import { TeacherSearchFilter } from "@/types/TeacherSearchFilter";
import { TeacherSubject } from "@/types/TeacherSubject";
import { UpdateAchievement } from "@/types/UpdateAchievement";
import {
  achievementImageUrl,
  removeAchievementImage,
  saveAchievementImage,
} from "@/lib/teacher-achievement-image";
import { UpdateQualification } from "@/types/UpdateQualification";
import { Prisma, TeacherTitle } from "@prisma/client";

import { promises as fs } from "fs";
import path from "path";

export class TeacherProfileSetupRequiredError extends Error {
  teacherName: string;
  suggestedSlug: string;
  slugAvailable: boolean;
  alternatives: string[];

  constructor(
    teacherName: string,
    suggestedSlug: string,
    slugAvailable: boolean,
    alternatives: string[]
  ) {
    super("This teacher does not have a public profile yet.");

    this.name = "TeacherProfileSetupRequiredError";
    this.teacherName = teacherName;
    this.suggestedSlug = suggestedSlug;
    this.slugAvailable = slugAvailable;
    this.alternatives = alternatives;
  }
}

function slugifyTeacherName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");
}

async function generateAvailableSlugAlternatives(
  baseSlug: string,
  count = 3
): Promise<string[]> {
  const alternatives: string[] = [];

  let suffix = 2;

  while (alternatives.length < count && suffix < 100) {
    const candidate = `${baseSlug}-${suffix}`;

    const taken = await prisma.teacherProfile.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });

    if (!taken) {
      alternatives.push(candidate);
    }

    suffix++;
  }

  return alternatives;
}

export async function getTeacherProfile(
  teacherId: string
) {
  const teacherProfileSelect = {
    id: true,
    teacherId: true,
    slug: true,

    title: true,
    displayName: true,

    profileImageUrl: true,
    coverImageUrl: true,

    designation: true,
    headline: true,
    aboutMe: true,
    qualificationSummary: true,

    yearsOfExperience: true,

    phone: true,
    whatsapp: true,

    districtId: true,
    cityId: true,

    facebookUrl: true,
    youtubeUrl: true,
    instagramUrl: true,
    tiktokUrl: true,
    websiteUrl: true,

    seoTitle: true,
    seoDescription: true,

    isVerified: true,
    isPublic: true,

    isDisplayQualification: true,
    isDisplayAchievements: true,
    isDisplaySubjects: true,

    profileViewCount: true,

    createdAt: true,
    updatedAt: true,

    qualifications:{
      select:{
        id:true,
        displayOrder:true,
        title:true,
        profile:true
      }
    },

    teacher: {
      select: {
        id: true,
        name: true,
        email: true,

        classes: {
          where: {
            status: 0,
          },
          orderBy: {
            createdAt: "desc",
          },
          select: {
            id: true,
            name: true,
            description: true,
            teacherId: true,
            monthlyFee: true,
            paymentDueWeek: true,
            startDate: true,
            schedule: true,

            schedules: {
              select: {
                id: true,
                dayOfWeek: true,
                startTime: true,
                endTime: true,
              },
              orderBy: [
                { dayOfWeek: "asc" },
                { startTime: "asc" },
              ],
            },

            students: {
              select: {
                id: true,
                isActive: true,
              },
            },
          },
        },
      },
    },

    district: {
      select: {
        name: true,
      },
    },

    city: {
      select: {
        name: true,
      },
    },
     mediums: {
      select: {
        medium: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    },
  } satisfies Prisma.TeacherProfileSelect;

  const profile = await prisma.teacherProfile.findUnique({
    where: { teacherId },
    select: teacherProfileSelect,
  });

  if (!profile) {
    const teacher = await prisma.teacher.findUnique({
      where: { id: teacherId },
      select: {
        name: true,
      },
    });

    if (!teacher) {
      throw new Error("Teacher not found");
    }

    const baseSlug = slugifyTeacherName(teacher.name);

    const takenBy = await prisma.teacherProfile.findUnique({
      where: { slug: baseSlug },
      select: { id: true },
    });

    const alternatives = takenBy
      ? await generateAvailableSlugAlternatives(baseSlug)
      : [];

    throw new TeacherProfileSetupRequiredError(
      teacher.name,
      baseSlug,
      !takenBy,
      alternatives
    );
  }

  const result: TeacherProfile = {
    profileId: profile.id,
    teacherId: profile.teacherId,
    slug: profile.slug,

    title: profile.title,
    displayName: profile.displayName,

    classes: profile.teacher.classes.map((cls) => ({
      id: cls.id,
      name: cls.name,
      description: cls.description,
      teacherId: cls.teacherId,
      monthlyFee: cls.monthlyFee,
      paymentDueWeek: cls.paymentDueWeek,
      startDate: cls.startDate?.toISOString() ?? "",
      schedule: cls.schedule,

      schedules: cls.schedules.map((s) => ({
        id: s.id,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
      })),

      students: cls.students.map((st) => ({
        id: st.id,
        isActive: st.isActive,
      })),
    })),

    profileImageUrl: profile.profileImageUrl,
    coverImageUrl: profile.coverImageUrl,

    designation: profile.designation,
    headline: profile.headline,
    aboutMe: profile.aboutMe,
    qualificationSummary:profile.qualifications.sort((a, b) => a.displayOrder - b.displayOrder)[0]?.title ?? null,

    yearsOfExperience: profile.yearsOfExperience,

    phone: profile.phone,
    whatsapp: profile.whatsapp,

    districtId: profile.districtId,
    cityId: profile.cityId,

    district: profile.district?.name ?? null,
    city: profile.city?.name ?? null,

    facebookUrl: profile.facebookUrl,
    youtubeUrl: profile.youtubeUrl,
    instagramUrl: profile.instagramUrl,
    tiktokUrl: profile.tiktokUrl,
    websiteUrl: profile.websiteUrl,

    seoTitle: profile.seoTitle,
    seoDescription: profile.seoDescription,

    isVerified: profile.isVerified,
    isPublic: profile.isPublic,

    isDisplayQualification: profile.isDisplayQualification,
    isDisplayAchievements: profile.isDisplayAchievements,
    isDisplaySubjects: profile.isDisplaySubjects,

    profileViewCount: profile.profileViewCount,

    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),

    teacher: {
      id: profile.teacher.id,
      name: profile.teacher.name,
      email: profile.teacher.email,
    },

    mediums: profile.mediums.map((m) => ({
      id: m.medium.id,
      name: m.medium.name,
    })),
  };

  return result;

}

export interface CreateTeacherProfileInput {
  title: TeacherTitle;
  displayName: string;
  slug: string;
}

export async function createTeacherProfile(
  teacherId: string,
  input: CreateTeacherProfileInput
) {
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: { id: true },
  });

  if (!teacher) {
    throw new Error("Teacher not found.");
  }

  const existingProfile = await prisma.teacherProfile.findUnique({
    where: { teacherId },
    select: { id: true },
  });

  if (existingProfile) {
    return getTeacherProfile(teacherId);
  }

  const slug = slugifyTeacherName(input.slug);

  if (!slug) {
    throw new Error("Please enter a valid profile link.");
  }

  const displayName = input.displayName?.trim();

  if (!displayName) {
    throw new Error("Please enter a display name.");
  }

  const taken = await prisma.teacherProfile.findFirst({
    where: { slug: { equals: slug, mode: "insensitive" } },
    select: { id: true },
  });

  if (taken) {
    throw new Error(
      "This profile link is already taken. Please choose another one."
    );
  }

  try {
    await prisma.teacherProfile.create({
      data: {
        teacherId,
        slug,
        title: input.title,
        displayName,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new Error(
        "This profile link is already taken. Please choose another one."
      );
    }

    throw error;
  }

  return getTeacherProfile(teacherId);
}

export async function GetTeacherPublicProfileBySlug(
  slug: string
): Promise<TeacherProfile> {
  const teacherProfileSelect = {
    id: true,
    teacherId: true,
    slug: true,

    title: true,
    displayName: true,

    profileImageUrl: true,
    coverImageUrl: true,

    designation: true,
    headline: true,
    aboutMe: true,
    qualificationSummary: true,

    yearsOfExperience: true,

    phone: true,
    whatsapp: true,

    districtId: true,
    cityId: true,

    facebookUrl: true,
    youtubeUrl: true,
    instagramUrl: true,
    tiktokUrl: true,
    websiteUrl: true,

    seoTitle: true,
    seoDescription: true,

    isVerified: true,
    isPublic: true,

    isDisplayQualification: true,
    isDisplayAchievements: true,
    isDisplaySubjects: true,

    profileViewCount: true,

    createdAt: true,
    updatedAt: true,

    qualifications: {
      select: {
        id: true,
        displayOrder: true,
        title: true,
        profile: true,
      },
      orderBy: {
        displayOrder: "asc",
      },
    },

    teacher: {
      select: {
        id: true,
        name: true,
        email: true,

        classes: {
          where: {
            status: 0,
          },
          orderBy: {
            createdAt: "desc",
          },
          select: {
            id: true,
            name: true,
            description: true,
            teacherId: true,
            monthlyFee: true,
            paymentDueWeek: true,
            startDate: true,
            schedule: true,

            schedules: {
              select: {
                id: true,
                dayOfWeek: true,
                startTime: true,
                endTime: true,
              },
              orderBy: [
                { dayOfWeek: "asc" },
                { startTime: "asc" },
              ],
            },

            students: {
              select: {
                id: true,
                isActive: true,
              },
            },
          },
        },
      },
    },

    district: {
      select: {
        name: true,
      },
    },

    city: {
      select: {
        name: true,
      },
    },

    mediums: {
      select: {
        medium: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    },
    
  } satisfies Prisma.TeacherProfileSelect;

  // Profile URLs keep the capitals the teacher typed, but /pathum and /Pathum
  // must open the same page.
  const profile = await prisma.teacherProfile.findFirst({
    where: { slug: { equals: slug, mode: "insensitive" } },
    select: teacherProfileSelect,
  });

  if (!profile) {
    throw new Error("Teacher not found.");
  }

  if (!profile.isPublic) {
    throw new Error("This profile is private.");
  }

  const result: TeacherProfile = {
    profileId: profile.id,
    teacherId: profile.teacherId,
    slug: profile.slug,

    title: profile.title,
    displayName: profile.displayName,

    classes: profile.teacher.classes.map((cls) => ({
      id: cls.id,
      name: cls.name,
      description: cls.description,
      teacherId: cls.teacherId,
      monthlyFee: cls.monthlyFee,
      paymentDueWeek: cls.paymentDueWeek,
      startDate: cls.startDate?.toISOString() ?? "",
      schedule: cls.schedule,

      schedules: cls.schedules.map((s) => ({
        id: s.id,
        dayOfWeek: s.dayOfWeek,
        startTime: s.startTime,
        endTime: s.endTime,
      })),

      students: cls.students.map((st) => ({
        id: st.id,
        isActive: st.isActive,
      })),
    })),

    profileImageUrl: profile.profileImageUrl,
    coverImageUrl: profile.coverImageUrl,

    designation: profile.designation,
    headline: profile.headline,
    aboutMe: profile.aboutMe,
    qualificationSummary:
      profile.qualifications[0]?.title ?? null,

    yearsOfExperience: profile.yearsOfExperience,

    phone: profile.phone,
    whatsapp: profile.whatsapp,

    districtId: profile.districtId,
    cityId: profile.cityId,

    district: profile.district?.name ?? null,
    city: profile.city?.name ?? null,

    facebookUrl: profile.facebookUrl,
    youtubeUrl: profile.youtubeUrl,
    instagramUrl: profile.instagramUrl,
    tiktokUrl: profile.tiktokUrl,
    websiteUrl: profile.websiteUrl,

    seoTitle: profile.seoTitle,
    seoDescription: profile.seoDescription,

    isVerified: profile.isVerified,
    isPublic: profile.isPublic,

    isDisplayQualification: profile.isDisplayQualification,
    isDisplayAchievements: profile.isDisplayAchievements,
    isDisplaySubjects: profile.isDisplaySubjects,

    profileViewCount: profile.profileViewCount,

    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),

    teacher: {
      id: profile.teacher.id,
      name: profile.teacher.name,
      email: profile.teacher.email,
    },

    mediums: profile.mediums.map((m) => ({
      id: m.medium.id,
      name: m.medium.name,
    })),
  };

  return result;
}


export async function updateTeacherProfile(
  teacherId: string,
  dto: UpdateTeacherProfile
) {
  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: {
      id: true,
      name: true,
    },
  });

  if (!teacher) {
    throw new Error("Teacher not found");
  }

  const defaultSlug = teacher.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-");

  const slug =
    dto.slug?.trim() || defaultSlug;

  const existingSlug =
    await prisma.teacherProfile.findFirst({
      where: {
        slug: { equals: slug, mode: "insensitive" },
        NOT: {
          teacherId,
        },
      },
    });

  if (existingSlug) {
    throw new Error(
      "Profile URL already taken."
    );
  }

  await prisma.$transaction(async (tx) => {

    await prisma.teacher.update({
        where: {
            id: teacherId,
        },
        data: {
            name: dto.name,
        },
    });

    await prisma.teacherProfile.upsert({
      where: {
        teacherId,
      },

      create: {
        teacherId,

        slug,

        title:
          dto.title ?? "MR",

        displayName:
          dto.displayName?.trim() || null,

        designation:
          dto.designation?.trim() || null,

        yearsOfExperience:
          dto.yearsOfExperience,

        phone:
          dto.phone?.trim() || null,

        whatsapp:
          dto.whatsapp?.trim() || null,

        isPublic:
          dto.isPublic ?? true,
      },

      update: {
        slug,

        title:
          dto.title,

        displayName:
          dto.displayName?.trim() || null,

        designation:
          dto.designation?.trim() || null,

        yearsOfExperience:
          dto.yearsOfExperience,

        phone:
          dto.phone?.trim() || null,

        whatsapp:
          dto.whatsapp?.trim() || null,

        isPublic:
          dto.isPublic,
      },
    });

  });


  return getTeacherProfile(teacherId);
}

export async function getQualifications(
  teacherId: string
) {
  const profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    select: {
      qualifications: {
        orderBy: {
          displayOrder: "asc",
        },
      },
    },
  });

  if (!profile) {
    throw new Error("Teacher profile not found");
  }

  return profile.qualifications;
}


export async function addQualification(
  teacherId: string,
  dto: AddQualification
) {
  const profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    select: {
      id: true,
      qualifications: {
        select: {
          displayOrder: true,
        },
        orderBy: {
          displayOrder: "desc",
        },
        take: 1,
      },
    },
  });

  if (!profile) {
    throw new Error("Teacher profile not found");
  }

  const nextDisplayOrder =
    (profile.qualifications[0]?.displayOrder ?? 0) + 1;

  return prisma.teacherQualification.create({
    data: {
      profileId: profile.id,

      title: dto.title.trim(),

      displayOrder: nextDisplayOrder,
    },
  });
}

export async function updateQualification(
  teacherId: string,
  qualificationId: string,
  dto: UpdateQualification
) {
  const qualification =
    await prisma.teacherQualification.findFirst({
      where: {
        id: qualificationId,
        profile: {
          teacherId,
        },
      },
    });

  if (!qualification) {
    throw new Error("Qualification not found");
  }

  return prisma.teacherQualification.update({
    where: {
      id: qualificationId,
    },
    data: {
      title: dto.title?.trim(),

      displayOrder: dto.displayOrder,
    },
  });
}


export async function deleteQualification(
  teacherId: string,
  qualificationId: string
) {
  const qualification =
    await prisma.teacherQualification.findFirst({
      where: {
        id: qualificationId,
        profile: {
          teacherId,
        },
      },
      select: {
        id: true,
      },
    });

  if (!qualification) {
    throw new Error("Qualification not found");
  }

  await prisma.teacherQualification.delete({
    where: {
      id: qualificationId,
    },
  });

  return {
    success: true,
    message: "Qualification deleted successfully",
  };
}


export async function getAchievements(
  teacherId: string
) {
  const profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    select: {
      achievements: {
        orderBy: [
          {
            displayOrder: "asc",
          },
          {
            year: "desc",
          },
        ],
      },
    },
  });

  return (profile?.achievements ?? []).map(toAchievementDto);
}

function toAchievementDto<T extends { id: string; imageName: string | null }>(
  achievement: T
) {
  return {
    ...achievement,
    imageUrl: achievement.imageName
      ? achievementImageUrl(achievement.id, achievement.imageName)
      : null,
  };
}


export async function addAchievement(
  teacherId: string,
  dto: AddAchievement,
  imageFile: File | null = null
) {
  const profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    select: {
      id: true,
      achievements: {
        select: {
          displayOrder: true,
        },
        orderBy: {
          displayOrder: "desc",
        },
        take: 1,
      },
    },
  });

  if (!profile) {
    throw new Error("Teacher profile not found");
  }

  const nextDisplayOrder =
    (profile.achievements[0]?.displayOrder ?? 0) + 1;

  const imageName = imageFile
    ? await saveAchievementImage(teacherId, imageFile)
    : null;

  const created = await prisma.teacherAchievement.create({
    data: {
      profileId: profile.id,

      title: dto.title.trim(),
      description: dto.description?.trim(),

      year: dto.year,

      imageName,

      displayOrder: nextDisplayOrder,
    },
  });

  return toAchievementDto(created);
}

export async function updateAchievement(
  teacherId: string,
  achievementId: string,
  dto: UpdateAchievement,
  image: { file: File | null; remove: boolean } = { file: null, remove: false }
) {
  const achievement =
    await prisma.teacherAchievement.findFirst({
      where: {
        id: achievementId,
        profile: {
          teacherId,
        },
      },
    });

  if (!achievement) {
    throw new Error("Achievement not found");
  }

  let imageName = achievement.imageName;

  if (image.file) {
    imageName = await saveAchievementImage(teacherId, image.file);
  } else if (image.remove) {
    imageName = null;
  }

  const updated = await prisma.teacherAchievement.update({
    where: {
      id: achievementId,
    },
    data: {
      title: dto.title?.trim(),
      description: dto.description?.trim(),
      year: dto.year,
      imageName,
      displayOrder: dto.displayOrder,
    },
  });

  if (imageName !== achievement.imageName) {
    await removeAchievementImage(teacherId, achievement.imageName);
  }

  return toAchievementDto(updated);
}

export async function deleteAchievement(
  teacherId: string,
  achievementId: string
) {
  const achievement =
    await prisma.teacherAchievement.findFirst({
      where: {
        id: achievementId,
        profile: {
          teacherId,
        },
      },
      select: {
        id: true,
        imageName: true,
      },
    });

  if (!achievement) {
    throw new Error("Achievement not found");
  }

  await prisma.teacherAchievement.delete({
    where: {
      id: achievementId,
    },
  });

  await removeAchievementImage(teacherId, achievement.imageName);

  return {
    success: true,
    message: "Achievement deleted successfully",
  };
}

export async function getMediums() {
  return prisma.medium.findMany({
    orderBy: {
      name: "asc",
    },
  });
}

export async function getTeacherMediums(
  teacherId: string
) {
  const profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    include: {
      mediums: {
        include: {
          medium: true,
        },
      },
    },
  });

  return profile?.mediums ?? [];
}

export async function updateTeacherMediums(
  teacherId: string,
  mediumIds: number[]
) {
  const profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    select: {
      id: true,
    },
  });

  if (!profile) {
    throw new Error("Teacher profile not found");
  }

  await prisma.teacherProfileMedium.deleteMany({
    where: {
      profileId: profile.id,
    },
  });

  if (mediumIds.length > 0) {
    await prisma.teacherProfileMedium.createMany({
      data: mediumIds.map((mediumId) => ({
        profileId: profile.id,
        mediumId,
      })),
      skipDuplicates: true,
    });
  }

  return prisma.teacherProfile.findUnique({
    where: {
      id: profile.id,
    },
    include: {
      mediums: {
        include: {
          medium: true,
        },
      },
    },
  });
}

export async function getSubjects() {
  return prisma.subject.findMany({
    orderBy: {
      name: "asc",
    },
  });
}

const TEACHING_LEVEL_ORDER: TeachingLevel[] = ["PRIMARY", "OL", "AL"];

export interface TeacherSubjectDto {
  id: string;
  subjectId: number;
  subject: { id: number; name: string };
  levels: TeachingLevel[];
}

/**
 * The database keeps one row per (subject, level); the UI works with one entry
 * per subject listing every level taught. `id` is the id of one of the subject's
 * rows and can be used to edit or delete the whole subject.
 */
function groupTeacherSubjects(
  rows: Array<{
    id: string;
    subjectId: number;
    teachingLevel: TeachingLevel;
    subject: { id: number; name: string };
  }>
): TeacherSubjectDto[] {
  const bySubject = new Map<number, TeacherSubjectDto>();

  for (const row of rows) {
    const existing = bySubject.get(row.subjectId);

    if (existing) {
      existing.levels.push(row.teachingLevel);
    } else {
      bySubject.set(row.subjectId, {
        id: row.id,
        subjectId: row.subjectId,
        subject: { id: row.subject.id, name: row.subject.name },
        levels: [row.teachingLevel],
      });
    }
  }

  return Array.from(bySubject.values()).map((entry) => ({
    ...entry,
    levels: TEACHING_LEVEL_ORDER.filter((level) =>
      entry.levels.includes(level)
    ),
  }));
}

function normalizeTeachingLevels(levels: unknown): TeachingLevel[] {
  if (!Array.isArray(levels)) {
    throw new Error("Select at least one teaching level.");
  }

  const valid = TEACHING_LEVEL_ORDER.filter((level) =>
    levels.includes(level)
  );

  if (valid.length === 0 || valid.length !== new Set(levels).size) {
    throw new Error("Select at least one valid teaching level.");
  }

  return valid;
}

async function getProfileIdForTeacher(teacherId: string) {
  const profile = await prisma.teacherProfile.findUnique({
    where: { teacherId },
    select: { id: true },
  });

  if (!profile) {
    throw new Error("Teacher profile not found");
  }

  return profile.id;
}

async function getGroupedSubject(profileId: string, subjectId: number) {
  const rows = await prisma.teacherProfileSubject.findMany({
    where: { profileId, subjectId },
    include: { subject: true },
  });

  return groupTeacherSubjects(rows)[0];
}

export async function getTeacherSubjects(
  teacherId: string
): Promise<TeacherSubjectDto[]> {
  const profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    select: {
      subjects: {
        include: {
          subject: true,
        },
        orderBy: {
          subject: {
            name: "asc",
          },
        },
      },
    },
  });

  if (!profile) {
    throw new Error("Teacher profile not found");
  }

  return groupTeacherSubjects(profile.subjects);
}

export interface AddTeacherSubjectDto {
  subjectId: number;
  levels: TeachingLevel[];
}

export async function addTeacherSubject(
  teacherId: string,
  dto: AddTeacherSubjectDto
) {
  const profileId = await getProfileIdForTeacher(teacherId);
  const levels = normalizeTeachingLevels(dto.levels);

  const existing = await prisma.teacherProfileSubject.findMany({
    where: { profileId, subjectId: dto.subjectId },
    select: { teachingLevel: true },
  });

  const existingLevels = new Set(existing.map((row) => row.teachingLevel));
  const missing = levels.filter((level) => !existingLevels.has(level));

  if (missing.length === 0) {
    throw new Error("This subject and level already exists.");
  }

  await prisma.teacherProfileSubject.createMany({
    data: missing.map((teachingLevel) => ({
      profileId,
      subjectId: dto.subjectId,
      teachingLevel,
    })),
    skipDuplicates: true,
  });

  return getGroupedSubject(profileId, dto.subjectId);
}

export interface UpdateTeacherSubjectDto {
  subjectId: number;
  levels: TeachingLevel[];
}

export async function updateTeacherSubject(
  teacherId: string,
  teacherSubjectId: string,
  dto: UpdateTeacherSubjectDto
) {
  const existing =
    await prisma.teacherProfileSubject.findFirst({
      where: {
        id: teacherSubjectId,
        profile: {
          teacherId,
        },
      },
    });

  if (!existing) {
    throw new Error("Subject not found.");
  }

  const levels = normalizeTeachingLevels(dto.levels);
  const { profileId } = existing;

  await prisma.$transaction(async (tx) => {
    // Changing the subject replaces the old subject's rows entirely.
    if (dto.subjectId !== existing.subjectId) {
      await tx.teacherProfileSubject.deleteMany({
        where: { profileId, subjectId: existing.subjectId },
      });
    }

    await tx.teacherProfileSubject.deleteMany({
      where: {
        profileId,
        subjectId: dto.subjectId,
        teachingLevel: { notIn: levels },
      },
    });

    await tx.teacherProfileSubject.createMany({
      data: levels.map((teachingLevel) => ({
        profileId,
        subjectId: dto.subjectId,
        teachingLevel,
      })),
      skipDuplicates: true,
    });
  });

  return getGroupedSubject(profileId, dto.subjectId);
}


export async function deleteTeacherSubject(
  teacherId: string,
  teacherSubjectId: string
) {
  const existing =
    await prisma.teacherProfileSubject.findFirst({
      where: {
        id: teacherSubjectId,
        profile: {
          teacherId,
        },
      },
      select: {
        profileId: true,
        subjectId: true,
      },
    });

  if (!existing) {
    throw new Error("Subject not found.");
  }

  // Removes the subject for every level.
  await prisma.teacherProfileSubject.deleteMany({
    where: {
      profileId: existing.profileId,
      subjectId: existing.subjectId,
    },
  });

  return {
    success: true,
  };
}


export async function getDistricts() {
  return prisma.district.findMany({
    orderBy: {
      name: "asc",
    },
  });
}

export async function getCitiesByDistrict(
  districtId: number
) {
  return prisma.city.findMany({
    where: {
      districtId,
    },
    orderBy: {
      name: "asc",
    },
  });
}

export async function getPublicTeacherProfile(
  slug: string
) {
  const profile = await prisma.teacherProfile.findFirst({
    where: {
      slug: { equals: slug, mode: "insensitive" },
      isPublic: true,
    },
    include: {
      teacher: {
        select: {
          id: true,
          name: true,
          createdAt: true,
        },
      },

      district: true,
      city: true,

      mediums: {
        include: {
          medium: true,
        },
      },

      subjects: {
        include: {
          subject: true,
        },
      },

      qualifications: {
        orderBy: {
          displayOrder: "asc",
        },
      },

      achievements: {
        orderBy: {
          displayOrder: "asc",
        },
      },
    },
  });

  if (!profile) {
    throw new Error("Teacher profile not found");
  }

  await prisma.teacherProfile.update({
    where: {
      id: profile.id,
    },
    data: {
      profileViewCount: {
        increment: 1,
      },
    },
  });

  const classes = await prisma.class.findMany({
    where: {
      teacherId: profile.teacherId,
      status: 0,
    },
    select: {
      id: true,
      name: true,
      description: true,
      monthlyFee: true,
      schedule: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return {
    id: profile.id,

    slug: profile.slug,

    name: profile.teacher.name,

    designation: profile.designation,
    headline: profile.headline,

    aboutMe: profile.aboutMe,
    qualificationSummary:
      profile.qualificationSummary,

    yearsOfExperience:
      profile.yearsOfExperience,

    profileImageUrl:
      profile.profileImageUrl,

    coverImageUrl:
      profile.coverImageUrl,

    district: profile.district?.name,
    city: profile.city?.name,

    mediums: profile.mediums.map(
      (x) => x.medium.name
    ),

    subjects: groupTeacherSubjects(
      profile.subjects
    ).map((x) => ({
      id: x.subject.id,
      name: x.subject.name,
      levels: x.levels,
    })),

    qualifications:
      profile.qualifications,

    achievements:
      profile.achievements,

    classes,
  };
}

export async function searchPublicTeachers(
  filter: TeacherSearchFilter
) {
  const page = filter.page ?? 1;
  const pageSize = filter.pageSize ?? 12;

  const where: any = {
    isPublic: true,
  };

  if (filter.districtId) {
    where.districtId = filter.districtId;
  }

  if (filter.cityId) {
    where.cityId = filter.cityId;
  }

  if (filter.mediumId) {
    where.mediums = {
      some: {
        mediumId: filter.mediumId,
      },
    };
  }

  if (filter.subjectId) {
    where.subjects = {
      some: {
        subjectId: filter.subjectId,
      },
    };
  }

  const [items, total] =
    await prisma.$transaction([
      prisma.teacherProfile.findMany({
        where,

        include: {
          teacher: {
            select: {
              name: true,
            },
          },

          district: true,
          city: true,

          mediums: {
            include: {
              medium: true,
            },
          },

          subjects: {
            include: {
              subject: true,
            },
          },
        },

        orderBy: {
          profileViewCount: "desc",
        },

        skip:
          (page - 1) * pageSize,

        take: pageSize,
      }),

      prisma.teacherProfile.count({
        where,
      }),
    ]);

  return {
    total,
    page,
    pageSize,

    items: items.map((teacher) => ({
      id: teacher.id,

      slug: teacher.slug,

      name: teacher.teacher.name,

      designation:
        teacher.designation,

      headline:
        teacher.headline,

      profileImageUrl:
        teacher.profileImageUrl,

      district:
        teacher.district?.name,

      city:
        teacher.city?.name,

      mediums:
        teacher.mediums.map(
          (x) => x.medium.name
        ),

      subjects: Array.from(
        new Set(
          teacher.subjects.map(
            (x) => x.subject.name
          )
        )
      ),

      profileViewCount:
        teacher.profileViewCount,
    })),
  };
}


export async function updateProfilePhoto(
  teacherId: string,
  file: File
) {
  const profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    select: {
      profileImageUrl: true,
    },
  });

  // Ensure upload folder exists
  const uploadDir = path.join(
    process.cwd(),
    "storage",
    "teachers"
  );

  await fs.mkdir(uploadDir, {
    recursive: true,
  });

  // Delete previous image
  if (profile?.profileImageUrl) {
    try {
      const oldFile = path.join(
        process.cwd(),
        "storage",
        "teachers",
        path.basename(profile.profileImageUrl)
      );

      await fs.unlink(oldFile);
    } catch {
      // Ignore if file doesn't exist
    }
  }

  // Extension
  const extension =
    path.extname(file.name) || ".jpg";

  // Unique filename
  const fileName = `${teacherId}-${Date.now()}${extension}`;

  const filePath = path.join(
    uploadDir,
    fileName
  );

  // Save file
  const bytes = await file.arrayBuffer();

  await fs.writeFile(
    filePath,
    Buffer.from(bytes)
  );

  const imageUrl =
`/uploads/teachers/${fileName}`;

  await prisma.teacherProfile.upsert({
    where: {
      teacherId,
    },
    create: {
      teacherId,
      slug: `teacher-${teacherId}`,
      profileImageUrl: imageUrl,
    },
    update: {
      profileImageUrl: imageUrl,
    },
  });

  return getTeacherProfile(teacherId);
}


export async function getTeacherProfilePhoto(
    teacherId: string
) {
    return prisma.teacherProfile.findUnique({
        where: {
            teacherId,
        },
        select: {
            profileImageUrl: true,
        },
    });
}

export async function updateCoverPhoto(
  teacherId: string,
  coverImageUrl: string
) {
  return prisma.teacherProfile.upsert({
    where: {
      teacherId,
    },
    create: {
      teacherId,
      slug: `teacher-${teacherId}`,
      coverImageUrl,
    },
    update: {
      coverImageUrl,
    },
  });
}


export async function getAboutMe(
  teacherId: string
) {
  const profile =
    await prisma.teacherProfile.findUnique({
      where: {
        teacherId,
      },
      select: {
        aboutMe: true,
      },
    });

  if (!profile)
    throw new Error("Teacher profile not found.");

  return profile;
}

export async function updateAboutMe(
  teacherId: string,
  aboutMe: string
) {
  return prisma.teacherProfile.update({
    where: {
      teacherId,
    },
    data: {
      aboutMe,
    },
    select: {
      aboutMe: true,
    },
  });
}

export type ProfileSection = "qualification" | "achievements" | "subjects";

export type SectionVisibility = {
  isDisplayQualification: boolean;
  isDisplayAchievements: boolean;
  isDisplaySubjects: boolean;
};

const SECTION_COLUMN: Record<ProfileSection, keyof SectionVisibility> = {
  qualification: "isDisplayQualification",
  achievements: "isDisplayAchievements",
  subjects: "isDisplaySubjects",
};

export async function getSectionVisibility(
  teacherId: string
): Promise<SectionVisibility> {
  const profile = await prisma.teacherProfile.findUnique({
    where: { teacherId },
    select: {
      isDisplayQualification: true,
      isDisplayAchievements: true,
      isDisplaySubjects: true,
    },
  });

  // Default everything to visible when a profile row does not exist yet.
  return {
    isDisplayQualification: profile?.isDisplayQualification ?? true,
    isDisplayAchievements: profile?.isDisplayAchievements ?? true,
    isDisplaySubjects: profile?.isDisplaySubjects ?? true,
  };
}

/**
 * Whether this teacher's whole public profile is visible. Sections with no
 * dedicated toggle (mediums, social links, About Me) fall back to this —
 * they're shown whenever the profile itself is public.
 */
export async function isProfilePublic(teacherId: string): Promise<boolean> {
  const profile = await prisma.teacherProfile.findUnique({
    where: { teacherId },
    select: { isPublic: true },
  });

  return profile?.isPublic ?? true;
}

export async function updateSectionVisibility(
  teacherId: string,
  section: ProfileSection,
  visible: boolean
): Promise<SectionVisibility> {
  const column = SECTION_COLUMN[section];

  if (!column) {
    throw new Error("Unknown profile section.");
  }

  const updated = await prisma.teacherProfile.update({
    where: { teacherId },
    data: { [column]: visible },
    select: {
      isDisplayQualification: true,
      isDisplayAchievements: true,
      isDisplaySubjects: true,
    },
  });

  return updated;
}

export async function getSocialLinks(
  teacherId: string
) {
  const profile =
    await prisma.teacherProfile.findUnique({
      where: {
        teacherId,
      },
      select: {
        facebookUrl: true,
        youtubeUrl: true,
        tiktokUrl: true,
        instagramUrl: true,
        websiteUrl: true,
      },
    });

  if (!profile) {
    throw new Error(
      "Teacher profile not found"
    );
  }

  return profile;
}


export async function updateSocialLinks(
  teacherId: string,
  dto: UpdateSocialLinks
) {
  return prisma.teacherProfile.update({
    where: {
      teacherId,
    },

    data: {
      facebookUrl: dto.facebookUrl?.trim() || null,

      youtubeUrl: dto.youtubeUrl?.trim() || null,

      tiktokUrl: dto.tiktokUrl?.trim() || null,

      instagramUrl:
        dto.instagramUrl?.trim() || null,

      websiteUrl:
        dto.websiteUrl?.trim() || null,
    },

    select: {
      facebookUrl: true,
      youtubeUrl: true,
      tiktokUrl: true,
      instagramUrl: true,
      websiteUrl: true,
    },
  });
}

