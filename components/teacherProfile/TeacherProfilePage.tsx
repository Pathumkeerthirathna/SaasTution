// components/teacherProfile/TeacherProfilePage.tsx

"use client";

import { useState } from "react";

import TeacherProfileHeader from "../../components/teacherProfile/TeacherProfileHeader";

import TeacherAboutCard from "./TeacherAboutCard";
import TeacherMediumsCard from "./TeacherMediumsCard";
import TeacherSocialLinksCard from "./TeacherSocialLinksCard";

import TeacherQualificationCard from "./TeacherQualificationCard";
import TeacherAchievementCard from "./TeacherAchievementCard";
import TeacherSubjectsCard from "./TeacherSubjectsCard";
import TeacherClassesCard from "./TeacherClassesCard";

import TeacherProfileDrawer from "./TeacherProfileDrawer";
import { TeacherProfile } from "@/types/teacherProfileTypes/ClassTeacher";

interface Props {
  teacher?: TeacherProfile;
  isPublic?: boolean;
}

export default function TeacherProfilePage({
  teacher,
  isPublic = false,
}: Props) {

  const [isDrawerOpen, setIsDrawerOpen] =
    useState(false);

  const [drawerMode, setDrawerMode] =
    useState<string>("");

  const openDrawer = (mode: string) => {
    setDrawerMode(mode);
    setIsDrawerOpen(true);
  };

 
 if (!teacher) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        Loading profile...
      </div>
    );
  }else {

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

          {/* Stats */}
          {/* <div className="mt-6">
            <TeacherProfileStats />
          </div> */}

          {/* Main Content */}
          <div className="mt-3 grid gap-2 lg:grid-cols-[320px_1fr]">

            {/* Left Column */}
            <div className="space-y-6">

              <TeacherAboutCard
                onEdit={() =>
                  openDrawer("about")
                }
                teacherId={teacher?.teacherId??""}
                isPublic={isPublic}
              />

              <TeacherSocialLinksCard
                onEdit={() =>
                  openDrawer("social")
                }
                teacherId={teacher?.teacherId??""}
                isPublic={isPublic}
              />

              {/* <TeacherProfileCompletionCard /> */}

              

              <TeacherMediumsCard
              teacherId={teacher?.teacherId??""}
              isPublic={isPublic}
              />

              

            </div>

            {/* Right Column */}
            <div className="space-y-6">

              <TeacherClassesCard
                teacherId={teacher?.teacherId??""}
                isPublic={isPublic}
              />

               <TeacherSubjectsCard
                teacherId={teacher?.teacherId??""}
                isPublic={isPublic}
              />

              <TeacherQualificationCard
                teacherId={teacher?.teacherId??""}
                isPublic={isPublic}
              />

              <TeacherAchievementCard
                teacherId={teacher?.teacherId??""}
                isPublic={isPublic}
              />


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
  

  
}