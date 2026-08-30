// components/teacherProfile/TeacherProfilePage.tsx

"use client";

import { useState } from "react";

import TeacherProfileHeader from "../../components/teacherProfile/TeacherProfileHeader";

import TeacherAboutCard from "./TeacherAboutCard";
import TeacherAnnouncementsCard from "./TeacherAnnouncementsCard";
import TeacherSocialLinksCard from "./TeacherSocialLinksCard";

import TeacherQualificationCard from "./TeacherQualificationCard";
import TeacherAchievementCard from "./TeacherAchievementCard";
import TeacherSubjectsCard from "./TeacherSubjectsCard";
import TeacherClassesCard from "./TeacherClassesCard";

import ProfileSectionsColumn, {
  ProfileSectionType,
} from "./ProfileSectionsColumn";

import TeacherProfileDrawer from "./TeacherProfileDrawer";
import { TeacherProfile } from "@/types/teacherProfileTypes/ClassTeacher";

interface Props {
  teacher?: TeacherProfile;
  isPublic?: boolean;
  /** Section display order resolved on the server. */
  sectionOrder?: ProfileSectionType[];
}

export default function TeacherProfilePage({
  teacher,
  isPublic = false,
  sectionOrder,
}: Props) {

  const [isDrawerOpen, setIsDrawerOpen] =
    useState(false);

  const [drawerMode, setDrawerMode] =
    useState<string>("");

  const openDrawer = (mode: string) => {
    setDrawerMode(mode);
    setIsDrawerOpen(true);
  };

  const teacherId = teacher?.teacherId ?? "";

  // Qualifications and Achievements render in the second column (below Classes),
  // so only the remaining sections are draggable in the first column.
  const sectionCards: Partial<Record<ProfileSectionType, React.ReactNode>> = {
    ABOUT_ME: (
      <TeacherAboutCard
        onEdit={() => openDrawer("about")}
        teacherId={teacherId}
        isPublic={isPublic}
      />
    ),
    ANNOUNCEMENTS: (
      <TeacherAnnouncementsCard teacherId={teacherId} isPublic={isPublic} />
    ),
    SUBJECTS: (
      <TeacherSubjectsCard
        teacherId={teacherId}
        isPublic={isPublic}
        sectionVisible={teacher?.isDisplaySubjects ?? true}
      />
    ),
    SOCIAL_MEDIA: (
      <TeacherSocialLinksCard
        onEdit={() => openDrawer("social")}
        teacherId={teacherId}
        isPublic={isPublic}
      />
    ),
  };

  return (
    <>
      <div className="min-h-screen bg-slate-50">
        <div className="mx-auto max-w-[1800px] px-3 py-4">

          {/* Header */}
          <TeacherProfileHeader
            onEdit={() =>
              openDrawer("profile")
            }
            teacher={teacher}
            isPublic={isPublic}
          />

          {/* Main Content */}
          <div className="mt-6 space-y-6">

            <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-3">

              {/* Ordered / draggable profile sections */}
              <div className="lg:col-span-1">
                <ProfileSectionsColumn
                  teacherId={teacherId}
                  isPublic={isPublic}
                  initialOrder={sectionOrder}
                  sections={sectionCards}
                />
              </div>

              {/* Classes + qualifications + achievements */}
              <div className="space-y-6 lg:col-span-2">
                <TeacherClassesCard
                  classes={teacher?.classes ?? []}
                  isPublic={isPublic}
                />

                <TeacherQualificationCard
                  teacherId={teacherId}
                  isPublic={isPublic}
                  sectionVisible={teacher?.isDisplayQualification ?? true}
                />

                <TeacherAchievementCard
                  teacherId={teacherId}
                  isPublic={isPublic}
                  sectionVisible={teacher?.isDisplayAchievements ?? true}
                />
              </div>
            </div>

          </div>
        </div>
      </div>

      <TeacherProfileDrawer
        open={isDrawerOpen}
        mode={drawerMode}
        onClose={() =>
          setIsDrawerOpen(false)
        }
      />
    </>
  );
}
