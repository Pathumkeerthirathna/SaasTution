"use client";

import { TeacherProfile } from "@/types/teacherProfileTypes/ClassTeacher";
import { UpdateTeacherProfile } from "@/types/teacherProfileTypes/UpdateTeacherProfile";
import {
  Award,
  Camera,
  Eye,
  GraduationCap,
  Languages,
  MapPin,
  MessageCircle,
  Pencil,
  Phone,
  UserCheck,
  Users,
  X,
} from "lucide-react";
import { useState, useEffect, useRef } from "react";

interface Props {
  onEdit?: () => void;
}

export default function TeacherProfileHeader({
  onEdit,
}: Props) {

  const [teacher, setTeacher] =
    useState<TeacherProfile | null>(null);

  const [loading, setLoading] =
    useState(true);

  const [isEditDrawerOpen, setIsEditDrawerOpen] = useState(false);

  const [districts, setDistricts] = useState<District[]>([]);
  const [cities, setCities] = useState<City[]>([]);

  const [districtId, setDistrictId] = useState<number | undefined>();
  const [cityId, setCityId] = useState<number | undefined>();

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

  useEffect(() => {
    loadDistricts();
    loadProfile();
  }, []);

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
      loadProfilePhoto();
  }, []);

  async function loadProfilePhoto() {
      const res = await fetch(
          "/api/teacher/profile/photo"
      );

      const data = await res.json();

      setProfilePhoto(data.profileImageUrl);
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

      const updated: TeacherProfile = await response.json();

      setTeacher(updated);
      setIsEditDrawerOpen(false);
    } catch (err) {
      console.error(err);
      alert("Failed to save profile.");
    }
  }

  async function loadProfile() {
    try {
      const response = await fetch("/api/teacher/profile");

      if (!response.ok) {
        throw new Error("Failed to load teacher profile.");
      }

      const data: TeacherProfile = await response.json();

      console.log(data);

      setTeacher(data);

      setDistrictId(data.districtId ?? undefined);
      setCityId(data.cityId ?? undefined);

      await loadDistricts();

      if (data.districtId) {
        await loadCities(data.districtId);
      }

    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  async function loadDistricts() {
    const res = await fetch("/api/teacher/master/districts");

    console.log(res);

    const data: District[] = await res.json();

    console.log(data);

    setDistricts(data);
  }


  async function loadCities(id: number) {
    const res = await fetch(
      `/api/teacher/master/cities?districtId=${id}`
    );

    const data: City[] = await res.json();

    setCities(data);
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

      loadProfilePhoto();

      const updated: TeacherProfile =
        await response.json();

      setTeacher(updated);

      setPreviewOpen(false);

      setSelectedImage(null);

      setPreviewUrl(null);

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

  return (
    <div className="relative
                overflow-hidden
                rounded-3xl
                border
                border-slate-200
                bg-white
                p-4
                shadow-sm
                transition-all
                duration-300
                hover:shadow-lg">
        {/* Left Accent */}
        

        {/* Bottom Accent */}
        <div className="absolute bottom-0 left-8 right-8 h-[3px] rounded-t-full bg-gradient-to-r from-orange-500/70 via-orange-300/40 to-transparent" />

        {/* Top Right Glow */}
        <div className="absolute right-0 top-0 h-28 w-28 rounded-full bg-orange-100/20 blur-3xl" />

        {/* Bottom Left Glow */}
        <div className="absolute bottom-0 left-0 h-24 w-24 rounded-full bg-emerald-100/20 blur-3xl" />
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">

        {/* Left */}
        <div className="flex gap-5">

          {/* Profile Image */}
          <div className="relative h-28 w-28 shrink-0">

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageSelected}
            />

            {/* Orange Accent Ring */}
            <div className="rounded-full bg-gradient-to-br from-orange-400 via-orange-500 to-orange-600 p-[2px] shadow-lg">

              {/* White Ring */}
              <div className="rounded-full bg-white p-[4px]">

                <img
                  src={profilePhoto}
                  alt={teacher?.teacher.name}
                  onClick={() => fileInputRef.current?.click()}
                  className="
                    h-24
                    w-24
                    cursor-pointer
                    rounded-full
                    object-cover
                    transition
                    duration-300
                    hover:scale-[1.03]
                  "
                />

              </div>

            </div>

            {/* Camera Button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="
                absolute
                bottom-1
                right-1
                flex
                h-8
                w-8
                items-center
                justify-center
                rounded-full
                border-2
                border-white
                bg-gradient-to-r
                from-emerald-600
                to-orange-500
                text-white
                shadow-lg
                transition-all
                duration-200
                hover:scale-110
                hover:shadow-xl
              "
              title="Change profile photo"
            >
              <Camera className="h-4 w-4" />
            </button>

          </div>
          {/* Content */}
          <div>

            {/* Name */}
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold text-slate-900">
                {teacher?.teacher.name}
              </h1>

              {teacher?.isVerified && (
                <span className="flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                  <UserCheck className="h-3.5 w-3.5" />
                  Verified Teacher
                </span>
              )}
            </div>

            {/* Designation */}
            <p className="mt-1 text-base font-semibold text-orange-600">
              {teacher?.designation ?? (
                <span className="italic text-slate-400">
                  Add your professional designation to display it on your public profile. (Hit Edit Profile to add)
                </span>
              )}
            </p>

            {/* Qualification */}
            {/* <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-600">
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

            <div className="mt-2 flex items-center gap-2 text-sm text-slate-600">
                <GraduationCap className="h-4 w-4 text-emerald-600" />

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
                      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-emerald-600 transition hover:bg-emerald-50"
                    >
                      <Pencil className="h-3 w-3" />
                      Add
                    </button>
                  </>
                )}
              </div>

            {/* Headline */}
            {/* <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
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

            <div className="flex items-center gap-2">
              <Award className="h-4 w-4 text-orange-500" />

              {teacher?.yearsOfExperience != null ? (
                `${teacher.yearsOfExperience} Years Experience`
              ) : (
                <span className="italic text-slate-400">
                  Add your teaching experience. (Hit Edit Profile to add)
                </span>
              )}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">

              {/* Phone */}
              <div className="flex items-center gap-2">

                <Phone className="h-4 w-4 text-emerald-600" />

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
                      className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-emerald-600 transition hover:bg-emerald-50"
                    >
                      <Pencil className="h-3 w-3" />
                      Add
                    </button>
                  </>
                )}

              </div>

              {/* Divider */}
              <div className="hidden h-4 w-px bg-slate-300 md:block" />

              {/* WhatsApp */}
              <div className="flex items-center gap-2">

                <MessageCircle className="h-4 w-4 text-green-600" />

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
                      className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-xs font-medium text-emerald-600 transition hover:bg-emerald-50"
                    >
                      <Pencil className="h-3 w-3" />
                      Add
                    </button>
                  </>
                )}

              </div>

            </div>

            

          </div>

        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-col items-start gap-4 lg:items-end">

          {/* Buttons */}
          <div className="flex gap-3">

            <button
              onClick={() => setIsEditDrawerOpen(true)}
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

          <div className="space-y-2">

            {/* First Line */}
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500 pl-6">
              <Languages className="h-4 w-4" />
              <span>Mediums:</span>
            </div>

            {teacher?.mediums?.length ? (

              <div className="flex flex-wrap gap-2 pl-6">
                {teacher.mediums.map((medium) => (
                  <span
                    key={medium.id}
                    className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700"
                  >
                    {medium.name}
                  </span>
                ))}
              </div>

            ) : (

              <div className="space-y-1 pl-6">

                {/* Second Line */}
                <p className="text-xs italic text-slate-400">
                  No teaching mediums added.
                </p>

                {/* Third Line */}
                <button
                  type="button"
                  // onClick={() => openDrawer("mediums")}
                  className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 transition hover:text-emerald-700"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Configure Mediums
                </button>

                {/* Fourth Line */}
                <p className="text-xs text-slate-400">
                  They will then appear here and on your public profile.
                </p>

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

                          <h2 className="text-xl font-bold text-slate-900">
                              Edit Profile
                          </h2>

                          <p className="mt-1 text-sm text-slate-500">
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
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    Public Profile URL
                  </label>

                  <div className="flex overflow-hidden rounded-xl border">

                    <div className="bg-slate-100 px-3 py-2.5 text-sm text-slate-500">
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
                      className="flex-1 px-3 py-2.5 text-sm outline-none"
                    />

                  </div>

                  {checkingSlug ? (

                      <p className="mt-2 text-xs text-slate-500">
                          Checking availability...
                      </p>

                  ) : (

                      <p
                          className={`mt-2 text-xs ${
                              slugAvailable
                                  ? "text-emerald-600"
                                  : "text-red-600"
                          }`}
                      >
                          {slugMessage}
                      </p>

                  )}

                  <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                      Public URL
                      <br />
                      <span className="font-medium text-emerald-600">
                          https://slclassroom.live/{form.slug}
                      </span>
                  </p>
                </div>

                <div>
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
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
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
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
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
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
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
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
                    className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-emerald-500"
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
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
                    City
                  </label>

                  <select
                    value={cityId ?? ""}
                    onChange={(e) =>
                      setCityId(Number(e.target.value))
                    }
                    disabled={!districtId}
                    className="w-full rounded-xl border border-slate-300 px-4 py-2.5 text-sm outline-none focus:border-emerald-500 disabled:bg-slate-100"
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
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
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
                  <label className="mb-2 block text-sm font-semibold text-slate-700">
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

                      <h4 className="text-sm font-semibold text-slate-900">
                        Public Profile
                      </h4>

                      <p className="mt-1 text-xs text-slate-500">
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
                          className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-medium hover:bg-slate-50"
                      >
                          Cancel
                      </button>

                      <button
                          className="rounded-xl bg-gradient-to-r from-emerald-600 to-orange-500 px-6 py-2.5 text-sm font-semibold text-white shadow-md hover:opacity-95"
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

      {previewOpen && (
        <div className="fixed inset-0 z-[60]">

          <div
            className="absolute inset-0 bg-black/70"
            onClick={() => setPreviewOpen(false)}
          />

          <div className="absolute left-1/2 top-1/2 w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-6 shadow-2xl">

            <h2 className="text-xl font-bold">
              Preview Profile Photo
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Double click the image or press Upload.
            </p>

            <img
              src={previewUrl!}
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
    
    </div>


    //
    
    

  );
}