"use client";

import { TeacherProfile } from "@/types/teacherProfileTypes/ClassTeacher";
import { UpdateTeacherProfile } from "@/types/teacherProfileTypes/UpdateTeacherProfile";
import {
  Award,
  Camera,
  Eye,
  GraduationCap,
  Languages,
  MessageCircle,
  Pencil,
  Phone,
  Share2,
  UserCheck,
  X,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";

import Image from "next/image";

import { Mail } from "lucide-react";
import { Medium, TeacherMedium } from "./Medium/medium-types";
import TeacherMediumDrawer from "./Medium/TeacherMediumDrawer";
import { BsLink45Deg } from "react-icons/bs";
import { FaWhatsapp, FaFacebookMessenger, FaTelegramPlane, FaFacebookF, FaLinkedinIn } from "react-icons/fa";

interface Props {
  teacher?: TeacherProfile;
  isPublic?: boolean;
  onEdit?: () => void;
}

export default function TeacherProfileHeader({
  teacher,
  isPublic = false,
  onEdit,
}: Props) {

  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false);

  // ── Teaching mediums edit ──
  const [mediums, setMediums] = useState<Medium[]>(teacher?.mediums ?? []);
  const [mediumsDrawerOpen, setMediumsDrawerOpen] = useState(false);
  const [allMediums, setAllMediums] = useState<Medium[]>([]);
  const [selectedMediumIds, setSelectedMediumIds] = useState<number[]>([]);
  const [savingMediums, setSavingMediums] = useState(false);

  useEffect(() => {
    setMediums(teacher?.mediums ?? []);
  }, [teacher]);

  async function openMediumsDrawer() {
    try {
      const [allResponse, selectedResponse] = await Promise.all([
        fetch("/api/teacher/profile/mediums/all"),
        fetch(`/api/teacher/profile/mediums?teacherId=${teacher?.teacherId}`),
      ]);

      if (!allResponse.ok || !selectedResponse.ok) {
        throw new Error("Failed to load mediums.");
      }

      const all: Medium[] = await allResponse.json();
      const selected: TeacherMedium[] = await selectedResponse.json();

      setAllMediums(all);
      setSelectedMediumIds(selected.map((x) => x.medium.id));
      setMediumsDrawerOpen(true);
    } catch (err) {
      console.error(err);
    }
  }

  function toggleMedium(id: number) {
    setSelectedMediumIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function saveMediums() {
    try {
      setSavingMediums(true);

      const response = await fetch("/api/teacher/profile/mediums", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediumIds: selectedMediumIds }),
      });

      if (!response.ok) {
        throw new Error("Failed to save mediums.");
      }

      const refreshed = await fetch(
        `/api/teacher/profile/mediums?teacherId=${teacher?.teacherId}`
      );
      const data: TeacherMedium[] = await refreshed.json();
      setMediums(data.map((x) => x.medium));

      setMediumsDrawerOpen(false);
    } catch (err) {
      console.error(err);
    } finally {
      setSavingMediums(false);
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedImage, setSelectedImage] =
  useState<File | null>(null);

  const [previewOpen, setPreviewOpen] = useState(false);

  const [previewUrl, setPreviewUrl] =
    useState<string | null>(null);

  const [uploading, setUploading] =
    useState(false);

  const [profilePhoto, setProfilePhoto] =
    useState("/images/avatar.png");

  const [form, setForm] =
    useState<UpdateTeacherProfile>({
        name: teacher?.teacher?.name??"",
        slug: teacher?.slug ?? "",
        designation:
            teacher?.designation ?? "",
        yearsOfExperience:
            teacher?.yearsOfExperience ??
            null,
        phone: teacher?.phone ?? "",
        whatsapp:
            teacher?.whatsapp ?? "",
        isPublic:
            teacher?.isPublic ?? true,
    });


  const slugify = (text: string) =>
    text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, "-");

  const [checkingSlug, setCheckingSlug] = useState(false);

  const [slugAvailable, setSlugAvailable] =
    useState(true);

  const [slugMessage, setSlugMessage] =
    useState("");

  const [showShareModal, setShowShareModal] = useState(false);

  const [imageLoading, setImageLoading] = useState(true);

  useEffect(() => {
   // loadProfile();
  }, []);

  const handleShare = async () => {
    console.log("Share clicked");

    const url = `https://slclassroom.live/${teacher?.slug}`;

    // Desktop always shows custom modal
    if (window.innerWidth > 768) {
      setShowShareModal(true);
      return;
    }

    // Mobile
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${teacher?.teacher.name} - Teacher Profile`,
          text: "Check out this teacher profile",
          url,
        });
        return;
      } catch (e) {
        console.log(e);
      }
    }

    setShowShareModal(true);
  };

  useEffect(() => {
      if (!teacher) return;

      setForm({
           name: teacher.teacher.name,
          slug: teacher.slug,
          designation:
              teacher.designation ?? "",
          yearsOfExperience:
              teacher.yearsOfExperience??0,
          phone: teacher.phone ?? "",
          whatsapp:
              teacher.whatsapp ?? "",
          isPublic:
              teacher.isPublic,
      });
  }, [teacher]);

  useEffect(() => {
    if (isPublic) {
        if (teacher?.profileImageUrl) {
            setProfilePhoto(
                `${teacher.profileImageUrl}?v=${Date.now()}`
            );
            setImageLoading(true);
        } else {
            setProfilePhoto("/images/avatar.png");
            setImageLoading(true);
        }
        return;
    }

    loadProfilePhoto();
}, [teacher, isPublic]);

  async function loadProfilePhoto() {
    try {
      const res = await fetch("/api/teacher/profile/photo", {
        cache: "no-store",
      });

      if (!res.ok) {
        console.log("Photo API failed", res.status);
        return;
      }

      const data = await res.json();

      setProfilePhoto(
          `${data.profileImageUrl}?v=${Date.now()}`
      );

      setPreviewOpen(false);
    } catch (err) {
      console.error(err);
    }
  }

  async function saveProfile() {
    try {
      const response = await fetch("/api/teacher/profile/header", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        const error = await response.text();
        alert(error);
        return;
      }

      //setTeacher(updated);
      setIsEditDrawerOpen(false);
    } catch (err) {
      console.error(err);
      alert("Failed to save profile.");
    }
  }

  function handleImageSelected(
    e: React.ChangeEvent<HTMLInputElement>
  ) {
    const file = e.target.files?.[0];

    if (!file) return;

    setSelectedImage(file);

    setPreviewUrl(
      URL.createObjectURL(file)
    );

    setPreviewOpen(true);
  }

  async function uploadProfilePhoto() {
    if (!selectedImage) return;

    try {
      setUploading(true);

      const form = new FormData();

      form.append(
        "photo",
        selectedImage
      );

      const response = await fetch(
        "/api/teacher/profile/photo",
        {
          method: "PUT",
          body: form,
        }
      );

      if (!response.ok) {
        throw new Error();
      }

      const data = await response.json();

      setProfilePhoto(
        `${data.profileImageUrl}?v=${Date.now()}`
      );

      //setTeacher(updated);

      setPreviewOpen(false);

      setSelectedImage(null);

      setPreviewUrl(null);

      // ✅ Reset file input so the same image can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

    } catch {
      alert("Failed to upload image.");
    } finally {
      setUploading(false);
    }
  }

  async function validateSlug() {

      if (!form.slug.trim()) {
          setSlugAvailable(false);
          setSlugMessage("Slug is required.");
          return;
      }

      try {

          setCheckingSlug(true);

          const res = await fetch(
              `/api/teacher/profile/check-slug?slug=${encodeURIComponent(form.slug)}`
          );

          const data = await res.json();

          console.log(data);

          setSlugAvailable(data.available);

          setSlugMessage(
              data.available
                  ? "This profile URL is available."
                  : "This profile URL is already taken."
          );

      } finally {

          setCheckingSlug(false);

      }
  }

  if (!teacher) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white p-4 shadow-sm animate-pulse">
      <div className="flex flex-col gap-4 lg:flex-row lg:justify-between">

        {/* Left */}
        <div className="flex gap-3.5">

          {/* Avatar */}
          <div className="h-20 w-20 shrink-0 rounded-full bg-slate-200" />

          {/* Details */}
          <div className="space-y-2.5">
            <div className="h-5 w-48 rounded bg-slate-200" />
            <div className="h-3.5 w-36 rounded bg-slate-200" />
            <div className="h-3 w-56 rounded bg-slate-200" />
            <div className="h-3 w-44 rounded bg-slate-200" />

            <div className="flex gap-3">
              <div className="h-3 w-24 rounded bg-slate-200" />
              <div className="h-3 w-24 rounded bg-slate-200" />
            </div>
          </div>
        </div>

        {/* Right */}
        <div className="space-y-2.5">
          <div className="h-9 w-32 rounded-lg bg-slate-200" />
          <div className="h-3 w-20 rounded bg-slate-200" />

          <div className="flex gap-1.5">
            <div className="h-7 w-16 rounded-full bg-slate-200" />
            <div className="h-7 w-16 rounded-full bg-slate-200" />
            <div className="h-7 w-16 rounded-full bg-slate-200" />
          </div>
        </div>

      </div>
    </div>
  );
}

  return (
    <div className="relative
                overflow-hidden
                rounded-xl
                border
                border-slate-200
                bg-white
                p-4
                shadow-sm
                transition-all
                duration-300
                hover:shadow-md">
        {/* Bottom Accent */}
        <div className="absolute bottom-0 left-8 right-8 h-[2px] rounded-t-full bg-gradient-to-r from-orange-500/70 via-orange-300/40 to-transparent" />

        {/* Top Right Glow */}
        <div className="absolute right-0 top-0 h-20 w-20 rounded-full bg-orange-100/20 blur-3xl" />

        {/* Bottom Left Glow */}
        <div className="absolute bottom-0 left-0 h-16 w-16 rounded-full bg-emerald-100/20 blur-3xl" />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">

        {/* Left */}
        <div className="flex gap-3.5">

          {/* Profile Image */}
          <div className="relative h-20 w-20 shrink-0">

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelected}
            />

            {/* Orange Accent Ring */}
            <div className="rounded-full bg-gradient-to-br from-orange-400 via-orange-500 to-orange-600 p-[2px] shadow-md">

              {/* White Ring */}
              <div className="rounded-full bg-white p-[3px]">

                <div className="relative h-[68px] w-[68px]">

                  {imageLoading && (
                      <div className="absolute inset-0 z-10 flex items-center justify-center rounded-full bg-white">
                          <div className="h-5 w-5 animate-spin rounded-full border-[3px] border-orange-200 border-t-orange-500" />
                      </div>
                  )}

                  <Image
                      unoptimized
                      src={profilePhoto}
                      alt={teacher?.teacher.name ?? "Teacher"}
                      width={68}
                      height={68}
                      onLoad={() => setImageLoading(false)}
                      onLoadingComplete={() => setImageLoading(false)}
                      onError={() => setImageLoading(false)}
                      className="h-[68px] w-[68px] rounded-full object-cover"
                  />

              </div>

              </div>

            </div>

            {/* Camera Button */}
            {!isPublic && (<button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="
                absolute
                bottom-0
                right-0
                flex
                h-6
                w-6
                items-center
                justify-center
                rounded-full
                border-2
                border-white
                bg-gradient-to-r
                from-emerald-600
                to-orange-500
                text-white
                shadow-md
                transition-all
                duration-200
                hover:scale-110
                hover:shadow-lg
              "
              title="Change profile photo"
            >
              <Camera className="h-3 w-3" />
            </button>)}

          </div>
          {/* Content */}
          <div>

            {/* Name */}
            <div className="flex flex-wrap items-center gap-1.5">
              <h1 className="text-[20px] font-bold text-slate-900">
                {teacher?.teacher.name}
              </h1>

              {teacher?.isVerified && (
                <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-semibold text-emerald-700">
                  <UserCheck className="h-3 w-3" />
                  Verified Teacher
                </span>
              )}
            </div>

            {/* Designation */}
            <p className="mt-0.5 text-[14px] font-semibold text-orange-600">
              {teacher?.designation ?? (
                <span className="italic text-slate-400">
                  Add your professional designation to display it on your public profile. (Hit Edit Profile to add)
                </span>
              )}
            </p>

            {/* Qualification */}
            {/* <div className="mt-2 flex flex-wrap items-center gap-2 text-[16px] text-slate-600">
              <GraduationCap className="h-4 w-4 text-emerald-600" />

              <span className="font-medium">
                {teacher?.qualificationSummary??"NOT SET (SET QUALIFICATIONS UNDER QUALIFICATIONS TAB THEN WILL DISPLAY HIGHEST)"}
              </span>

              <span className="text-slate-400">
                •
              </span>

              <span>
                {teacher?.aboutMe}
              </span>
            </div> */}

            <div className="mt-1.5 flex items-center gap-1.5 text-[14px] text-slate-600">
                <GraduationCap className="h-3.5 w-3.5 shrink-0 text-emerald-600" />

                {teacher?.qualificationSummary ? (
                  <span className="font-medium">
                    {teacher.qualificationSummary}
                  </span>
                ) : (
                  <>
                    <span className="italic text-slate-400">
                      No qualifications available.
                    </span>

                    <button
                      type="button"
                      // onClick={() => openDrawer("qualification")}
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[13px] font-medium text-emerald-600 transition hover:bg-emerald-50"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                      Add
                    </button>
                  </>
                )}
              </div>

            {/* Headline */}
            {/* <p className="mt-3 max-w-3xl text-[16px] leading-6 text-slate-600">
              {teacher.headline}
            </p> */}

            {/* Meta */}
            {/* <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-emerald-600" />

              {teacher?.city || teacher?.district ? (
                <>
                  {teacher.city ?? ""}
                  {teacher.city && teacher.district ? ", " : ""}
                  {teacher.district ?? ""}
                </>
              ) : (
                <span className="italic text-slate-400">
                  Set your location to help students find nearby classes. (Hit Edit Profile to add)
                </span>
              )}
            </div> */}

            <div className="mt-1 flex items-center gap-1.5 text-[14px] text-slate-600">
              <Award className="h-3.5 w-3.5 shrink-0 text-orange-500" />

              {teacher?.yearsOfExperience != null ? (
                `${teacher.yearsOfExperience} Years Experience`
              ) : (
                <span className="italic text-slate-400">
                  Add your teaching experience. (Hit Edit Profile to add)
                </span>
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[14px]">

              {/* Phone */}
              <div className="flex items-center gap-1.5">

                <Phone className="h-3.5 w-3.5 shrink-0 text-emerald-600" />

                {teacher?.phone ? (
                  <span className="text-slate-700">
                    {teacher.phone}
                  </span>
                ) : (
                  <>
                    <span className="italic text-slate-400">
                      Phone not added
                    </span>

                    <button
                      type="button"
                      onClick={onEdit}
                      className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-medium text-emerald-600 transition hover:bg-emerald-50"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                      Add
                    </button>
                  </>
                )}

              </div>

              {/* Divider */}
              <div className="hidden h-3 w-px bg-slate-300 md:block" />

              {/* WhatsApp */}
              <div className="flex items-center gap-1.5">

                <MessageCircle className="h-3.5 w-3.5 shrink-0 text-green-600" />

                {teacher?.whatsapp ? (
                  <span className="text-slate-700">
                    {teacher.whatsapp}
                  </span>
                ) : (
                  <>
                    <span className="italic text-slate-400">
                      WhatsApp not added
                    </span>

                    <button
                      type="button"
                      onClick={onEdit}
                      className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-medium text-emerald-600 transition hover:bg-emerald-50"
                    >
                      <Pencil className="h-2.5 w-2.5" />
                      Add
                    </button>
                  </>
                )}

              </div>

            </div>

            

          </div>

        </div>

        {/* Actions */}
        <div className="w-full lg:w-fit">

  {/* Action Buttons */}

  <div className="flex items-center justify-end gap-2 whitespace-nowrap">

        <button
          type="button"
          onClick={handleShare}
          className="
            inline-flex
            h-9
            items-center
            justify-center
            gap-1.5
            rounded-lg
            bg-gradient-to-r
            from-emerald-600
            to-orange-500
            px-3.5
            text-[14px]
            font-semibold
            text-white
            shadow-sm
            transition
            hover:shadow-md
          "
        >
            <Share2
                className="h-3.5 w-3.5 pointer-events-none"
            />

            <span className="pointer-events-none">
                Share
            </span>
        </button>

    {!isPublic && (
      <>
        <button
          onClick={() => setIsEditDrawerOpen(true)}
          className="
            h-9
            rounded-lg
            bg-emerald-600
            px-3.5
            text-[14px]
            font-semibold
            text-white
            shadow-sm
            transition
            hover:bg-emerald-700
        "
        >
          Edit Profile
        </button>

        <button
          className="
            h-9
            rounded-lg
            border
            border-orange-300
            bg-white
            px-3.5
            text-[14px]
            font-semibold
            text-orange-600
            transition
            hover:bg-orange-50
        "
        >
          <Eye className="mr-1.5 inline h-3.5 w-3.5" />
          Public Profile
        </button>
      </>
    )}

  </div>

  {/* Medium Card */}

  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">

      <div className="mb-2 flex items-center justify-between gap-1.5">

          <div className="flex items-center gap-1.5">

              <Languages className="h-3.5 w-3.5 text-emerald-600" />

              <span className="text-[14px] font-semibold text-slate-700">
                  Teaching Mediums
              </span>

          </div>

          {!isPublic && (
              <button
                  type="button"
                  onClick={openMediumsDrawer}
                  title="Edit teaching mediums"
                  aria-label="Edit teaching mediums"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-emerald-200 bg-white text-emerald-600 transition hover:bg-emerald-50"
              >
                  <Pencil className="h-3 w-3" />
              </button>
          )}

      </div>

      {mediums.length ? (

          <div className="flex flex-wrap gap-1.5">

              {mediums.map((medium) => (

                  <span
                      key={medium.id}
                      className="
                          rounded-full
                          border
                          border-emerald-200
                          bg-white
                          px-2.5
                          py-0.5
                          text-[13px]
                          font-medium
                          text-emerald-700
                      "
                  >
                      {medium.name}
                  </span>

              ))}

          </div>

      ) : (

          <div>

              <p className="text-[14px] text-slate-400">
                  No teaching mediums added.
              </p>

              {!isPublic && (

                  <button
                      type="button"
                      onClick={openMediumsDrawer}
                      className="
                          mt-2
                          rounded-md
                          bg-emerald-50
                          px-2.5
                          py-1.5
                          text-[13px]
                          font-medium
                          text-emerald-700
                          hover:bg-emerald-100
                      "
                  >
                      Configure Mediums
                  </button>

              )}

          </div>

      )}

  </div>

</div>

      </div>

      {/* Edit header drawer */}


      {isEditDrawerOpen && (
        <div className="fixed inset-0 z-50">

               {/* Backdrop */}
          <div
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
              onClick={() => setIsEditDrawerOpen(false)}
          />

          {/* Drawer */}
          <div className="absolute right-0 top-0 h-screen w-full max-w-[560px] overflow-y-auto bg-white shadow-2xl">

              {/* Header */}

              <div className="sticky top-0 z-20 border-b bg-white px-6 py-5">

                  <div className="flex items-start justify-between">

                      <div>

                          <h2 className="text-[22px] font-bold text-slate-900">
                              Edit Profile
                          </h2>

                          <p className="mt-1 text-[16px] text-slate-500">
                              Update your public teacher profile.
                          </p>

                      </div>

                      <button
                        onClick={() => setIsEditDrawerOpen(false)}
                        className="rounded-xl p-2 hover:bg-slate-100"
                      >
                          <X className="h-5 w-5" />
                      </button>

                  </div>

              </div>

              {/* Body */}

              <div className="space-y-6 p-6">

                {/* Public URL */}
                <div>
                  <label className="mb-2 block text-[16px] font-semibold text-slate-700">
                    Public Profile URL
                  </label>

                  <div className="flex overflow-hidden rounded-xl border">

                    <div className="bg-slate-100 px-3 py-2.5 text-[16px] text-slate-500">
                      slclassroom.live/
                    </div>

                    <input
                      value={form.slug}
                      onChange={(e) =>
                        setForm((prev) => ({
                          ...prev,
                          slug: e.target.value,
                        }))
                      }
                      onBlur={validateSlug}
                      className="flex-1 px-3 py-2.5 text-[16px] outline-none"
                    />

                  </div>

                  {checkingSlug ? (

                      <p className="mt-2 text-[14px] text-slate-500">
                          Checking availability...
                      </p>

                  ) : (

                      <p
                          className={`mt-2 text-[14px] ${
                              slugAvailable
                                  ? "text-emerald-600"
                                  : "text-red-600"
                          }`}
                      >
                          {slugMessage}
                      </p>

                  )}

                  <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[14px] text-slate-500">
                      Public URL
                      <br />
                      <span className="font-medium text-emerald-600">
                          https://slclassroom.live/{form.slug}
                      </span>
                  </p>
                </div>

                <div>
                  <label className="mb-2 block text-[16px] font-semibold text-slate-700">
                      Full Name
                  </label>

                  <input
                      value={form.name}
                      onChange={(e) => {
                          const name = e.target.value;

                          setForm((prev) => ({
                              ...prev,
                              name,
                              slug: slugify(name),
                          }));
                      }}
                      className="w-full rounded-xl border border-slate-300 px-4 py-2.5"
                      placeholder="Your full name"
                  />
              </div>

                {/* Designation */}
                <div>
                  <label className="mb-2 block text-[16px] font-semibold text-slate-700">
                    Designation
                  </label>

                  <input
                    value={form.designation ?? ""}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        designation: e.target.value,
                      }))
                    }
                    className="w-full rounded-xl border border-slate-300 px-4 py-2.5"
                    placeholder="Mathematics Teacher"
                  />
                </div>

                {/* Experience */}
                <div>
                  <label className="mb-2 block text-[16px] font-semibold text-slate-700">
                    Teaching Experience
                  </label>

                  <input
                    type="number"
                    value={form.yearsOfExperience ?? ""}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        yearsOfExperience:
                          e.target.value === ""
                            ? null
                            : Number(e.target.value),
                      }))
                    }
                     className="w-full rounded-xl border border-slate-300 px-4 py-2.5"
                     placeholder="8 Years of ex.."
                  />
                </div>

                {/* District */}
                {/* <div>
                  <label className="mb-2 block text-[16px] font-semibold text-slate-700">
                    District
                  </label>

                  <select
                    value={districtId ?? ""}
                    onChange={async (e) => {
                      const id = Number(e.target.value);

                      setDistrictId(id);
                      setCityId(undefined);

                      await loadCities(id);
                    }}
                    className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-[16px] outline-none focus:border-emerald-500"
                  >
                    <option value="">
                      Select District
                    </option>

                    {districts.map((district) => (
                      <option
                        key={district.id}
                        value={district.id}
                      >
                        {district.name}
                      </option>
                    ))}
                  </select>
                </div> */}

                {/* City */}
                {/* <div>
                  <label className="mb-2 block text-[16px] font-semibold text-slate-700">
                    City
                  </label>

                  <select
                    value={cityId ?? ""}
                    onChange={(e) =>
                      setCityId(Number(e.target.value))
                    }
                    disabled={!districtId}
                    className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-[16px] outline-none focus:border-emerald-500 disabled:bg-slate-100"
                  >
                    <option value="">
                      Select City
                    </option>

                    {cities.map((city) => (
                      <option
                        key={city.id}
                        value={city.id}
                      >
                        {city.name}
                      </option>
                    ))}
                  </select>
                </div> */}

                {/* Phone */}
                <div>
                  <label className="mb-2 block text-[16px] font-semibold text-slate-700">
                    Contact Number
                  </label>

                  <input
                    value={form.phone ?? ""}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        phone: e.target.value,
                      }))
                    }
                     className="w-full rounded-xl border border-slate-300 px-4 py-2.5"
                     placeholder="07x-xxxxxxx"
                  />
                </div>

                {/* WhatsApp */}
                <div>
                  <label className="mb-2 block text-[16px] font-semibold text-slate-700">
                    WhatsApp Number
                  </label>

                 <input
                    value={form.whatsapp ?? ""}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        whatsapp: e.target.value,
                      }))
                    }
                     className="w-full rounded-xl border border-slate-300 px-4 py-2.5"
                     placeholder="07x-xxxxxxx"
                  />
                </div>

                {/* Public Profile */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">

                  <div className="flex items-center justify-between">

                    <div>

                      <h4 className="text-[16px] font-semibold text-slate-900">
                        Public Profile
                      </h4>

                      <p className="mt-1 text-[14px] text-slate-500">
                        Allow students to view your teacher profile.
                      </p>

                    </div>

                    <label className="relative inline-flex cursor-pointer items-center">

                      <input
                        type="checkbox"
                        checked={form.isPublic}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            isPublic: e.target.checked,
                          }))
                        }
                        className="peer sr-only"
                      />

                      <div className="peer h-6 w-11 rounded-full bg-slate-300 transition peer-checked:bg-emerald-600 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:after:translate-x-5" />

                    </label>

                  </div>

                </div>

              </div>

              {/* Footer */}

              <div className="sticky bottom-0 border-t bg-white px-6 py-4">

                  <div className="flex justify-end gap-3">

                      <button
                          onClick={() => setIsEditDrawerOpen(false)}
                          className="rounded-xl border border-slate-300 px-5 py-2.5 text-[16px] font-medium hover:bg-slate-50"
                      >
                          Cancel
                      </button>

                      <button
                          className="rounded-xl bg-gradient-to-r from-emerald-600 to-orange-500 px-6 py-2.5 text-[16px] font-semibold text-white shadow-md hover:opacity-95"
                          onClick={saveProfile}
                          disabled={!slugAvailable || checkingSlug}
                      >
                          Save Changes
                      </button>

                  </div>

              </div>

          </div>

        </div>
      )}

     {showShareModal && (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">

        <div className="w-full max-w-xl rounded-3xl bg-white shadow-2xl">

          {/* Teacher */}

          <div className="border-b border-slate-100 px-6 py-5">

             <button
              onClick={() => setShowShareModal(false)}
              className="rounded-xl p-2 hover:bg-slate-100"
            >
              <X size={20} />
            </button>

            <div className="flex items-center gap-4">

              <Image
                unoptimized
                src={profilePhoto}
                alt={teacher?.teacher.name ?? "Teacher profile"}
                width={64}
                height={64}
                className="h-16 w-16 rounded-full border object-cover"
              />

              <div>

                <h3 className="text-[20px] font-bold text-slate-900">
                  {teacher?.teacher.name}
                </h3>

                <p className="text-orange-600 font-medium">
                  {teacher?.designation}
                </p>

                <p className="mt-1 text-[16px] text-slate-500">
                  Share this profile with your students and parents.
                </p>

              </div>

            </div>

          </div>

          {/* Share Apps */}

          <div className="px-6 py-6">

            <h4 className="mb-4 text-[16px] font-semibold uppercase tracking-wide text-slate-500">
              Share Via
            </h4>

            <div className="grid grid-cols-4 gap-5">

              {/* WhatsApp */}

              <button
                onClick={() =>
                  window.open(
                    `https://wa.me/?text=${encodeURIComponent(
                      `https://slclassroom.live/${teacher?.slug}`
                    )}`,
                    "_blank"
                  )
                }
                className="group flex flex-col items-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#25D366]/10 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg">

                  <FaWhatsapp
                    size={30}
                    className="text-[#25D366]"
                  />

                </div>

                <span className="mt-2 text-[14px] font-medium">
                  WhatsApp
                </span>

              </button>

              {/* Messenger */}

              <button
                onClick={() =>
                  window.open(
                    `https://www.facebook.com/dialog/send?link=${encodeURIComponent(
                      `https://slclassroom.live/${teacher?.slug}`
                    )}`,
                    "_blank"
                  )
                }
                className="group flex flex-col items-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#0084FF]/10 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg">

                  <FaFacebookMessenger
                    size={28}
                    className="text-[#0084FF]"
                  />

                </div>

                <span className="mt-2 text-[14px]">
                  Messenger
                </span>

              </button>

              {/* Telegram */}

              <button
                onClick={() =>
                  window.open(
                    `https://t.me/share/url?url=${encodeURIComponent(
                      `https://slclassroom.live/${teacher?.slug}`
                    )}`,
                    "_blank"
                  )
                }
                className="group flex flex-col items-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#229ED9]/10 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg">

                  <FaTelegramPlane
                    size={28}
                    className="text-[#229ED9]"
                  />

                </div>

                <span className="mt-2 text-[14px]">
                  Telegram
                </span>

              </button>

              {/* Facebook */}

              <button
                onClick={() =>
                  window.open(
                    `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
                      `https://slclassroom.live/${teacher?.slug}`
                    )}`,
                    "_blank"
                  )
                }
                className="group flex flex-col items-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#1877F2]/10 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg">

                  <FaFacebookF
                    size={25}
                    className="text-[#1877F2]"
                  />

                </div>

                <span className="mt-2 text-[14px]">
                  Facebook
                </span>

              </button>

              {/* LinkedIn */}

              <button
                onClick={() =>
                  window.open(
                    `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
                      `https://slclassroom.live/${teacher?.slug}`
                    )}`,
                    "_blank"
                  )
                }
                className="group flex flex-col items-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-[#0A66C2]/10 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg">

                  <FaLinkedinIn
                    size={26}
                    className="text-[#0A66C2]"
                  />

                </div>

                <span className="mt-2 text-[14px]">
                  LinkedIn
                </span>

              </button>

              {/* Email */}

              <button
                onClick={() =>
                  window.open(
                    `mailto:?subject=${encodeURIComponent(
                      `${teacher?.teacher.name} - Teacher Profile`
                    )}&body=${encodeURIComponent(
                      `https://slclassroom.live/${teacher?.slug}`
                    )}`
                  )
                }
                className="group flex flex-col items-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-orange-100 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg">

                  <Mail
                    size={26}
                    className="text-orange-600"
                  />

                </div>

                <span className="mt-2 text-[14px]">
                  Email
                </span>

              </button>

              {/* X */}

              <button
                onClick={() =>
                  window.open(
                    `https://twitter.com/intent/tweet?url=${encodeURIComponent(
                      `https://slclassroom.live/${teacher?.slug}`
                    )}`,
                    "_blank"
                  )
                }
                className="group flex flex-col items-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg">

                  <span className="text-[22px] font-bold">
                    X
                  </span>

                </div>

                <span className="mt-2 text-[14px]">
                  X
                </span>

              </button>

              {/* Copy */}

              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(
                    `https://slclassroom.live/${teacher?.slug}`
                  );

                  alert("Profile link copied.");

                  setShowShareModal(false);
                }}
                className="group flex flex-col items-center"
              >
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-slate-100 transition-all duration-300 group-hover:-translate-y-1 group-hover:shadow-lg">

                  <BsLink45Deg
                    size={30}
                    className="text-slate-700"
                  />

                </div>

                <span className="mt-2 text-[14px]">
                  Copy Link
                </span>

              </button>

            </div>

          </div>

          {/* Profile URL */}

          <div className="border-t border-slate-200 bg-slate-50 px-6 py-5">

            <label className="mb-2 block text-[16px] font-semibold text-slate-700">
              Profile Link
            </label>

            <div className="flex overflow-hidden rounded-xl border border-slate-300 bg-white">

              <input
                readOnly
                value={`https://slclassroom.live/${teacher?.slug}`}
                className="flex-1 px-4 py-3 text-[16px] outline-none"
              />

              <button
                onClick={async () => {
                  await navigator.clipboard.writeText(
                    `https://slclassroom.live/${teacher?.slug}`
                  );

                  alert("Copied");
                }}
                className="bg-gradient-to-r from-emerald-600 to-orange-500 px-6 font-semibold text-white transition hover:opacity-90"
              >
                Copy
              </button>

            </div>

          </div>

        </div>

      </div>
    )}

      {previewOpen && (
        <div className="fixed inset-0 z-[60]">

          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => setPreviewOpen(false)}
          />

          <div className="absolute left-1/2 top-1/2 w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-6 shadow-2xl">

            <h2 className="text-[22px] font-bold">
              Preview Profile Photo
            </h2>

            <p className="mt-1 text-[16px] text-slate-500">
              Double click the image or press Upload.
            </p>

            <img
              src={previewUrl!}
              alt="Profile photo preview"
              onDoubleClick={uploadProfilePhoto}
              className="mt-6 h-80 w-full cursor-pointer rounded-2xl object-cover"
            />

            <div className="mt-6 flex justify-end gap-3">

              <button
                onClick={() =>
                  setPreviewOpen(false)
                }
                className="rounded-xl border px-5 py-2"
              >
                Cancel
              </button>

              <button
                onClick={uploadProfilePhoto}
                disabled={uploading}
                className="rounded-xl bg-gradient-to-r from-emerald-600 to-orange-500 px-6 py-2.5 text-white"
              >
                {uploading
                  ? "Uploading..."
                  : "Upload"}
              </button>

            </div>

          </div>

        </div>
      )}

      <TeacherMediumDrawer
        open={mediumsDrawerOpen}
        saving={savingMediums}
        mediums={allMediums}
        selectedMediumIds={selectedMediumIds}
        onToggle={toggleMedium}
        onSave={saveMediums}
        onClose={() => setMediumsDrawerOpen(false)}
      />

    </div>


    //
    
    

  );
}