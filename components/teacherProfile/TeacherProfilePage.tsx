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
import TeacherPaymentDetailsButton from "./TeacherPaymentDetailsCard";
import { TeacherClass, TeacherProfile } from "@/types/teacherProfileTypes/ClassTeacher";
import type { PublishedPaymentAccount } from "@/services/teacher-payment-account-service";
import type { TeacherProfileViewerRole } from "@/services/teacher-profile-viewer-service";

interface Props {
  teacher?: TeacherProfile;
  isPublic?: boolean;
  /** Section display order resolved on the server. */
  sectionOrder?: ProfileSectionType[];
  /**
   * Who is viewing, resolved on the SERVER from the session (never from the
   * client): OWNER gets the Payment Details management card; STUDENT gets the
   * enrolled / available class sections; PUBLIC (the default) the public
   * profile. It only selects what is rendered - every change is authorized by
   * the server again.
   */
  viewerRole?: TeacherProfileViewerRole;
  /** The teacher's PUBLISHED payment accounts (display fields only), for visitors and students. */
  paymentAccounts?: PublishedPaymentAccount[];
  /** A signed-in student's split of the public class list. */
  studentClasses?: { enrolled: TeacherClass[]; available: TeacherClass[] };
}

export default function TeacherProfilePage({
  teacher,
  isPublic = false,
  sectionOrder,
  viewerRole = "PUBLIC",
  paymentAccounts = [],
  studentClasses,
}: Props) {
  // isPublic={false} is only ever the signed-in teacher's OWN profile page
  // (/dashboard/teacher/profile, /teacher/profile: teacher session + that
  // teacher's own profile), so it is always the owner view - a page that
  // forgets viewerRole cannot hide Payment Details management. Rendering only:
  // every management call is authorized again by the server.
  const role: NonNullable<Props["viewerRole"]> = isPublic ? viewerRole : "OWNER";
  const isOwner = role === "OWNER";

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
            extraActions={
              // A compact Payment Details button in the header's action row: the owner manages
              // (dialog); visitors / students view the published accounts (no button when none).
              isOwner ? (
                <TeacherPaymentDetailsButton mode="manage" />
              ) : (
                <TeacherPaymentDetailsButton mode="view" accounts={paymentAccounts} />
              )
            }
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
                {role === "STUDENT" && studentClasses ? (
                  <>
                    <TeacherClassesCard
                      classes={studentClasses.enrolled}
                      isPublic={isPublic}
                      accent="enrolled"
                      heading="Your Enrolled Classes"
                      description="Classes you are currently enrolled in with this teacher."
                      countLabel="Enrolled"
                      emptyText="You are not enrolled in any of this teacher's classes yet."
                      classHref={() => "/student/classes"}
                      hideSummary
                    />
                    <TeacherClassesCard
                      classes={studentClasses.available}
                      isPublic={isPublic}
                      heading="Available Classes"
                      description="Other classes this teacher offers that you are not enrolled in."
                      countLabel="Available"
                      emptyText="No other classes are available right now."
                      hideSummary
                    />
                  </>
                ) : (
                  <TeacherClassesCard
                    classes={teacher?.classes ?? []}
                    isPublic={isPublic}
                  />
                )}

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
