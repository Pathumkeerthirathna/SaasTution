"use client";

import {
  GraduationCap,
  Phone,
  ShieldCheck,
} from "lucide-react";

import { Grade } from "@/types/grade";
import { useEffect, useState } from "react";

interface Props {
  classId: string;
}



export default function ClassRegisterCard({
  classId,
}: Props) {

  const [grades, setGrades] = useState<Grade[]>([]);
  const [selectedGrade, setSelectedGrade] = useState("");
  const [loadingGrades, setLoadingGrades] = useState(true);

  const [studentName, setStudentName] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [parentMobileNumber, setParentMobileNumber] = useState("");
  const [email, setEmail] = useState("");

  const [isRegistering, setIsRegistering] = useState(false);

  useEffect(() => {
  
    void loadGrades();
  }, []);

  const [errors, setErrors] = useState({
    studentName: "",
    mobileNumber: "",
    parentMobileNumber: "",
    email: "",
    grade: "",
  });

  async function loadGrades() {
    try {
      setLoadingGrades(true);

      const response = await fetch("/api/Grade");

      if (!response.ok) {
        throw new Error("Failed to load grades");
      }

      const data: Grade[] = await response.json();
      setGrades(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingGrades(false);
    }
  }

  async function registerStudent() {
    const validationErrors = {
      studentName: "",
      mobileNumber: "",
      parentMobileNumber: "",
      email: "",
      grade: "",
    };

    let hasError = false;

    if (!studentName.trim()) {
      validationErrors.studentName = "Student name is required.";
      hasError = true;
    }

    if (!mobileNumber.trim()) {
      validationErrors.mobileNumber = "Mobile number is required.";
      hasError = true;
    }

    if (!email.trim()) {
      validationErrors.email = "Email address is required.";
      hasError = true;
    } else if (
      !/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)
    ) {
      validationErrors.email = "Please enter a valid email address.";
      hasError = true;
    }

    if (!selectedGrade) {
      validationErrors.grade = "Please select a grade.";
      hasError = true;
    }

    setErrors(validationErrors);

    if (hasError) return;

    // Call API

    setIsRegistering(true);

    console.log(email);


    try {
      const response = await fetch("/api/students/public/Register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          classId,
          studentName,
          mobileNumber,
          parentMobileNumber,
          gradeId: parseInt(selectedGrade, 10),
          email,
        }),
      });

      const result = await response.json();

      console.log(result);

      if (!response.ok) {
        alert(result.message ?? "Registration failed.");
        return;
      }

      alert("Student registered successfully!");

      // Optional: clear form
      setStudentName("");
      setMobileNumber("");
      setEmail("");
      setSelectedGrade("");
    } catch (error) {
      console.error(error);
      alert("Something went wrong. Please try again.");
    }

    setIsRegistering(false);
  }

  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl">

      {/* Header */}

     <div className="relative overflow-hidden bg-gradient-to-r from-emerald-600 via-emerald-600 to-orange-500 px-6 py-5 text-white">

        {/* Decorative Circle */}

        <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-white/10" />
        <div className="absolute -right-3 bottom-3 h-12 w-12 rounded-full bg-white/10" />

        <div className="relative flex items-center justify-between">

          <div>

            <h2 className="mt-2 text-2xl font-bold text-white">
              Join This Class
            </h2>

          </div>

          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-sm">

            <GraduationCap className="h-7 w-7 text-white" />

          </div>

        </div>

      </div>

      

      {/* Form */}

      <div className="space-y-3 p-5">

        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-700">
            Student Name
          </label>

          <input
            value={studentName}
            onChange={(e) => {
              setStudentName(e.target.value);

              setErrors((prev) => ({
                ...prev,
                studentName: "",
              }));
            }}
           className={`w-full rounded-lg px-3 py-2.5 text-sm outline-none transition
                        ${
                          errors.studentName
                            ? "border border-red-500 focus:border-red-500"
                            : "border border-slate-300 focus:border-emerald-500"
                        }`}
                      placeholder="Enter student name"
                    />

        </div>

        {errors.studentName && (
          <p className="mt-1 text-[11px] text-red-600">
            {errors.studentName}
          </p>
        )}

        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-700">
            Mobile Number
          </label>

          <input
            value={mobileNumber}
            onChange={(e) => {
              setMobileNumber(e.target.value);

              setErrors((prev) => ({
                ...prev,
                mobileNumber: "",
              }));
            }}
            className={`w-full rounded-lg px-3 py-2.5 text-sm outline-none transition
                        ${
                          errors.mobileNumber
                            ? "border border-red-500 focus:border-red-500"
                            : "border border-slate-300 focus:border-emerald-500"
                        }`}
            placeholder="07XXXXXXXX"
            required
          />
        </div>

        {errors.mobileNumber && (
          <p className="mt-1 text-[11px] text-red-600">
            {errors.mobileNumber}
          </p>
        )}

        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-700">
            Parent / Guardian Mobile Number
          </label>

          <input
            value={parentMobileNumber}
            onChange={(e) => setParentMobileNumber(e.target.value)}
            className={`w-full rounded-lg px-3 py-2.5 text-sm outline-none transition
                      ${
                        errors.parentMobileNumber
                          ? "border border-red-500 focus:border-red-500"
                          : "border border-slate-300 focus:border-emerald-500"
                      }`}
            placeholder="07XXXXXXXX"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-semibold text-slate-700">
            Email Address
          </label>

          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);

              setErrors((prev) => ({
                ...prev,
                email: "",
              }));
            }}
            className={`w-full rounded-lg px-3 py-2.5 text-sm outline-none transition
                      ${
                        errors.email
                          ? "border border-red-500 focus:border-red-500"
                          : "border border-slate-300 focus:border-emerald-500"
                      }`}
            placeholder="example@email.com"
          />
        </div>

        {errors.email && (
          <p className="mt-1 text-[11px] text-red-600">
            {errors.email}
          </p>
        )}

        {/* <div>
          <label className="mb-1 block text-xs font-semibold text-slate-700">
            School
          </label>

          <input
            className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-emerald-500"
            placeholder="Your School"
          />
        </div> */}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium text-slate-700">
              Grade
            </label>

            {loadingGrades && (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-emerald-600" />
            )}
          </div>

          <select
            required
            disabled={loadingGrades}
            value={selectedGrade}
            onChange={(e) => {
              setSelectedGrade(e.target.value);

              setErrors((prev) => ({
                ...prev,
                grade: "",
              }));
            }}
            className={`w-full rounded-lg px-3 py-2.5 text-sm outline-none transition
                      ${
                        errors.grade
                          ? "border border-red-500 focus:border-red-500"
                          : "border border-slate-300 focus:border-emerald-500"
                      }`}
          >
            <option value="">
              {loadingGrades ? "Loading grades..." : "Select Grade"}
            </option>

            {!loadingGrades &&
              grades.map((grade) => (
                <option key={grade.id} value={grade.id}>
                  {grade.GradeDesc}
                </option>
              ))}
          </select>
        </div>

        {errors.grade && (
          <p className="mt-1 text-[11px] text-red-600">
            {errors.grade}
          </p>
        )}

        {/* Buttons */}

        <button
          type="button"
          disabled={isRegistering}
          onClick={registerStudent}
          className={`
            flex w-full items-center justify-center gap-2
            rounded-xl py-3.5 text-sm font-semibold text-white transition
            ${
              isRegistering
                ? "cursor-not-allowed bg-emerald-400"
                : "bg-emerald-600 hover:bg-emerald-700"
            }
          `}
        >
          {isRegistering ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Registering...
            </>
          ) : (
            "Register Now"
          )}
        </button>

        <button
          className="
            flex
            w-full
            items-center
            justify-center
            gap-2
            rounded-xl
            border
            border-orange-300
            bg-orange-50
            py-3.5
            text-sm
            font-semibold
            text-orange-700
            transition
            hover:bg-orange-100
          "
        >
          <Phone className="h-4 w-4" />
          Contact Teacher
        </button>

      </div>

      {/* Included */}

      {/* <div className="border-t border-slate-200 bg-slate-50 p-6">

        <h3 className="font-semibold text-slate-900">
          Included
        </h3>

        <div className="mt-4 space-y-3">

          {[
            "All Live Classes",
            "Video Recordings",
            "Lecture Notes",
            "Past Papers",
            "Assignments",
            "Teacher Support",
          ].map((item) => (
            <div
              key={item}
              className="flex items-center gap-3"
            >
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />

              <span className="text-sm text-slate-700">
                {item}
              </span>
            </div>
          ))}

        </div>

      </div> */}

      {/* Footer */}

      <div className="border-t border-slate-200 p-5">

        <div className="flex items-center gap-3">

          <ShieldCheck className="h-5 w-5 text-emerald-600" />

          <p className="text-xs leading-5 text-slate-500">
            Your registration details are securely
            protected.
          </p>

        </div>

        {/* <div className="mt-4 flex items-center gap-3">

          <CreditCard className="h-5 w-5 text-orange-500" />

          <p className="text-xs leading-5 text-slate-500">
            Flexible monthly payments with no
            hidden charges.
          </p>

        </div> */}

      </div>

    </div>
  );
}