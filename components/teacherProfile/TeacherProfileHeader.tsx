"use client";

import {
  Award,
  Eye,
  GraduationCap,
  Languages,
  MapPin,
  UserCheck,
  Users,
} from "lucide-react";

interface Props {
  onEdit?: () => void;
}

export default function TeacherProfileHeader({
  onEdit,
}: Props) {
  const teacher = {
    name: "Pathum Kumara",

    designation: "Mathematics Teacher",

    highestQualification:
      "BSc (Hons) Mathematics",

    institute:
      "University of Colombo",

    headline:
      "Helping students achieve A passes in Mathematics and build confidence for examinations.",

    district: "Colombo",

    city: "Maharagama",

    experience: 8,

    students: 1520,

    verified: true,

    mediums: [
      "Sinhala Medium",
      "English Medium",
    ],

    profileImage:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=500",
  };

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">

        {/* Left */}
        <div className="flex gap-5">

          {/* Profile Image */}
          <div className="shrink-0">
            <img
              src={teacher.profileImage}
              alt={teacher.name}
              className="h-24 w-24 rounded-2xl object-cover shadow-md ring-2 ring-slate-100"
            />
          </div>

          {/* Content */}
          <div>

            {/* Name */}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold text-slate-900">
                {teacher.name}
              </h1>

              {teacher.verified && (
                <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                  <UserCheck className="h-3.5 w-3.5" />
                  Verified Teacher
                </span>
              )}
            </div>

            {/* Designation */}
            <p className="mt-1 text-base font-semibold text-orange-600">
              {teacher.designation}
            </p>

            {/* Qualification */}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
              <GraduationCap className="h-4 w-4 text-emerald-600" />

              <span className="font-medium">
                {teacher.highestQualification}
              </span>

              <span className="text-slate-400">
                •
              </span>

              <span>
                {teacher.institute}
              </span>
            </div>

            {/* Headline */}
            {/* <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              {teacher.headline}
            </p> */}

            {/* Meta */}
            <div className="mt-4 flex flex-wrap gap-5 text-sm text-slate-500">

              <div className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-emerald-600" />
                {teacher.city},{" "}
                {teacher.district}
              </div>

              <div className="flex items-center gap-2">
                <Award className="h-4 w-4 text-orange-500" />
                {teacher.experience} Years Experience
              </div>

              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-emerald-600" />
                {teacher.students.toLocaleString()} Students
              </div>

            </div>

            

          </div>

        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-col items-start gap-4 lg:items-end">

          {/* Buttons */}
          <div className="flex gap-3">

            <button
              onClick={onEdit}
              className="
                rounded-xl
                bg-emerald-600
                px-4
                py-2.5
                text-sm
                font-semibold
                text-white
                transition
                hover:bg-emerald-700
              "
            >
              Edit Profile
            </button>

            <button
              className="
                flex
                items-center
                gap-2
                rounded-xl
                border
                border-orange-300
                bg-orange-50
                px-4
                py-2.5
                text-sm
                font-semibold
                text-orange-700
                transition
                hover:bg-orange-100
              "
            >
              <Eye className="h-4 w-4" />
              Public Profile
            </button>

          </div>

          {/* Mediums */}
          <div className="flex flex-wrap items-center gap-2">

            <div className="mr-1 flex items-center gap-2 text-xs font-medium text-slate-500">
              <Languages className="h-4 w-4" />
              Mediums:
            </div>

            {teacher.mediums.map((medium) => (
              <span
                key={medium}
                className="
                  rounded-full
                  border
                  border-emerald-200
                  bg-emerald-50
                  px-3
                  py-1
                  text-xs
                  font-medium
                  text-emerald-700
                "
              >
                {medium}
              </span>
            ))}
          </div>

        </div>

      </div>
    </div>
  );
}