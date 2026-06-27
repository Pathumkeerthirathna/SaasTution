import { prisma } from "@/lib/prisma";
import { AddAchievement } from "@/types/AddAchievement";
import { AddQualification } from "@/types/AddQualification";
import { TeacherSearchFilter } from "@/types/TeacherSearchFilter";
import { TeacherSubject } from "@/types/TeacherSubject";
import { UpdateAchievement } from "@/types/UpdateAchievement";
import { UpdateQualification } from "@/types/UpdateQualification";
import { UpdateTeacherProfile } from "@/types/UpdateTeacherProfile";

export async function getTeacherProfile(
  teacherId: string
) {
  let profile = await prisma.teacherProfile.findUnique({
    where: {
      teacherId,
    },
    include: {
      district: true,
      city: true,

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

    profile = await prisma.teacherProfile.create({
      data: {
        teacherId,
        slug: teacher.name
          .toLowerCase()
          .replace(/\s+/g, "-"),
      },
      include: {
        district: true,
        city: true,
        qualifications: true,
        achievements: true,
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
    });
  }

  return profile;
}

export async function updateTeacherProfile(
  teacherId: string,
  dto: UpdateTeacherProfile
) {

  const existingSlug = await prisma.teacherProfile.findFirst({
    where: {
      slug: dto.slug,
      NOT: {
        teacherId,
      },
    },
  });

  if (existingSlug) {
    throw new Error("Profile URL already taken");
  }

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

  const profile = await prisma.teacherProfile.upsert({
    where: {
      teacherId,
    },
    create: {
      teacherId,

      slug: dto.slug || defaultSlug,

      designation: dto.designation,
      headline: dto.headline,

      aboutMe: dto.aboutMe,
      qualificationSummary: dto.qualificationSummary,

      yearsOfExperience: dto.yearsOfExperience,

      phone: dto.phone,
      whatsapp: dto.whatsapp,

      districtId: dto.districtId,
      cityId: dto.cityId,

      facebookUrl: dto.facebookUrl,
      youtubeUrl: dto.youtubeUrl,
      tiktokUrl: dto.tiktokUrl,
      instagramUrl: dto.instagramUrl,
      websiteUrl: dto.websiteUrl,

      seoTitle: dto.seoTitle,
      seoDescription: dto.seoDescription,

      isPublic: dto.isPublic ?? true,
    },
    update: {
      slug: dto.slug,

      designation: dto.designation,
      headline: dto.headline,

      aboutMe: dto.aboutMe,
      qualificationSummary: dto.qualificationSummary,

      yearsOfExperience: dto.yearsOfExperience,

      phone: dto.phone,
      whatsapp: dto.whatsapp,

      districtId: dto.districtId,
      cityId: dto.cityId,

      facebookUrl: dto.facebookUrl,
      youtubeUrl: dto.youtubeUrl,
      tiktokUrl: dto.tiktokUrl,
      instagramUrl: dto.instagramUrl,
      websiteUrl: dto.websiteUrl,

      seoTitle: dto.seoTitle,
      seoDescription: dto.seoDescription,

      isPublic: dto.isPublic,
    },
    include: {
      district: true,
      city: true,
    },
  });

  return profile;
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
    include: {
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

  return profile?.subjects ?? [];
}

export async function updateTeacherSubjects(
  teacherId: string,
  subjects: TeacherSubject[]
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

  await prisma.teacherProfileSubject.deleteMany({
    where: {
      profileId: profile.id,
    },
  });

  if (subjects.length > 0) {
    await prisma.teacherProfileSubject.createMany({
      data: subjects.map((subject) => ({
        profileId: profile.id,
        subjectId: subject.subjectId,
        gradeFrom: subject.gradeFrom,
        gradeTo: subject.gradeTo,
      })),
      skipDuplicates: true,
    });
  }

  return prisma.teacherProfile.findUnique({
    where: {
      id: profile.id,
    },
    include: {
      subjects: {
        include: {
          subject: true,
        },
      },
    },
  });
}


export async function deleteTeacherSubject(
  teacherId: string,
  teacherProfileSubjectId: string
) {
  const record =
    await prisma.teacherProfileSubject.findFirst({
      where: {
        id: teacherProfileSubjectId,
        profile: {
          teacherId,
        },
      },
      select: {
        id: true,
      },
    });

  if (!record) {
    throw new Error("Subject not found");
  }

  await prisma.teacherProfileSubject.delete({
    where: {
      id: teacherProfileSubjectId,
    },
  });

  return {
    success: true,
    message: "Subject deleted successfully",
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
  profileImageUrl: string
) {
  return prisma.teacherProfile.upsert({
    where: {
      teacherId,
    },
    create: {
      teacherId,
      slug: `teacher-${teacherId}`,
      profileImageUrl,
    },
    update: {
      profileImageUrl,
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