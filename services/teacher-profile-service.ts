import { prisma } from "@/lib/prisma";
import { AddAchievement } from "@/types/AddAchievement";
import { AddQualification } from "@/types/AddQualification";
import { TeacherProfile } from "@/types/teacherProfileTypes/ClassTeacher";
import { UpdateSocialLinks } from "@/types/teacherProfileTypes/SocialLink/types";
import { UpdateTeacherProfile } from "@/types/teacherProfileTypes/UpdateTeacherProfile";
import { TeacherSearchFilter } from "@/types/TeacherSearchFilter";
import { TeacherSubject } from "@/types/TeacherSubject";
import { UpdateAchievement } from "@/types/UpdateAchievement";
import { UpdateQualification } from "@/types/UpdateQualification";
import { Prisma } from "@prisma/client";

import { promises as fs } from "fs";
import path from "path";

export async function getTeacherProfile(
  teacherId: string
) {
  const teacherProfileSelect = {
    id: true,
    teacherId: true,
    slug: true,

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

    profileViewCount: true,

    createdAt: true,
    updatedAt: true,

    qualifications:{
      select:{
        id:true,
        displayOrder:true,
        title:true,
        institute:true,
        profile:true
      }
    },

    teacher: {
      select: {
        id: true,
        name: true,
        email: true,
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

  let profile = await prisma.teacherProfile.findUnique({
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

    await prisma.teacherProfile.create({
      data: {
        teacherId,
        slug: teacher.name
          .toLowerCase()
          .replace(/\s+/g, "-"),
      },
    });

    profile = await prisma.teacherProfile.findUnique({
      where: { teacherId },
      select: teacherProfileSelect,
    });

    if (!profile) {
      throw new Error("Failed to create teacher profile.");
    }
  }

  const result: TeacherProfile = {
    profileId: profile.id,
    teacherId: profile.teacherId,
    slug: profile.slug,

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
        slug,
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
        orderBy: [
          {
            displayOrder: "asc",
          },
          {
            endYear: "desc",
          },
        ],
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
      institute: dto.institute.trim(),

      startYear: dto.startYear,
      endYear: dto.endYear,

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
      institute: dto.institute?.trim(),

      startYear: dto.startYear,
      endYear: dto.endYear,

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

  return profile?.achievements ?? [];
}


export async function addAchievement(
  teacherId: string,
  dto: AddAchievement
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

  return prisma.teacherAchievement.create({
    data: {
      profileId: profile.id,

      title: dto.title.trim(),
      description: dto.description?.trim(),

      year: dto.year,

      displayOrder: nextDisplayOrder,
    },
  });
}

export async function updateAchievement(
  teacherId: string,
  achievementId: string,
  dto: UpdateAchievement
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

  return prisma.teacherAchievement.update({
    where: {
      id: achievementId,
    },
    data: {
      title: dto.title?.trim(),
      description: dto.description?.trim(),
      year: dto.year,
      displayOrder: dto.displayOrder,
    },
  });
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

export async function getTeacherSubjects(
  teacherId: string
) {
  const profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    select: {
      subjects: {
        include: {
          subject: true,
        },
        orderBy: [
          {
            subject: {
              name: "asc",
            },
          },
          {
            gradeFrom: "asc",
          },
        ],
      },
    },
  });

  if (!profile) {
    throw new Error("Teacher profile not found");
  }

  return profile.subjects;
}

export interface AddTeacherSubjectDto {
  subjectId: number;
  gradeFrom: number;
  gradeTo: number;
}

export async function addTeacherSubject(
  teacherId: string,
  dto: AddTeacherSubjectDto
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

  const exists =
    await prisma.teacherProfileSubject.findFirst({
      where: {
        profileId: profile.id,
        subjectId: dto.subjectId,
        gradeFrom: dto.gradeFrom,
        gradeTo: dto.gradeTo,
      },
    });

  if (exists) {
    throw new Error(
      "This subject and grade range already exists."
    );
  }

  return prisma.teacherProfileSubject.create({
    data: {
      profileId: profile.id,
      subjectId: dto.subjectId,
      gradeFrom: dto.gradeFrom,
      gradeTo: dto.gradeTo,
    },
    include: {
      subject: true,
    },
  });
}

export interface UpdateTeacherSubjectDto {
  subjectId: number;
  gradeFrom: number;
  gradeTo: number;
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

  return prisma.teacherProfileSubject.update({
    where: {
      id: teacherSubjectId,
    },
    data: {
      subjectId: dto.subjectId,
      gradeFrom: dto.gradeFrom,
      gradeTo: dto.gradeTo,
    },
    include: {
      subject: true,
    },
  });
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
        id: true,
      },
    });

  if (!existing) {
    throw new Error("Subject not found.");
  }

  await prisma.teacherProfileSubject.delete({
    where: {
      id: teacherSubjectId,
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
      slug,
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

    subjects: profile.subjects.map(
      (x) => ({
        id: x.subject.id,
        name: x.subject.name,
        gradeFrom: x.gradeFrom,
        gradeTo: x.gradeTo,
      })
    ),

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

      subjects:
        teacher.subjects.map(
          (x) => x.subject.name
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
    "public",
    "uploads",
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
        "public",
        profile.profileImageUrl.replace(/^\/+/, "")
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

  const imageUrl = `/uploads/teachers/${fileName}`;

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

export async function GetTeacherPublicProfileBySlug(
  slug: string
): Promise<TeacherProfile> {
  const teacherProfileSelect = {
    id: true,
    teacherId: true,
    slug: true,

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

    profileViewCount: true,

    createdAt: true,
    updatedAt: true,

    qualifications: {
      select: {
        id: true,
        displayOrder: true,
        title: true,
        institute: true,
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
    where: { slug },
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