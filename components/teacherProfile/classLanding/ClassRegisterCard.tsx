"use client";

import {
  CheckCircle2,
  Clock,
  GraduationCap,
  Mail,
  Phone,
  ShieldCheck,
} from "lucide-react";

import { Grade } from "@/types/grade";
import { useEffect, useState } from "react";
import toast from "react-hot-toast/headless";

interface Props {
  classId: string;
  teacherId: string;
}



export default function ClassRegisterCard({
  classId,
  teacherId
}: Props) {

  const [grades, setGrades] = useState<Grade[]>([]);
  const [selectedGrade, setSelectedGrade] = useState("");
  const [loadingGrades, setLoadingGrades] = useState(true);

  const [studentName, setStudentName] = useState("");
  const [mobileNumber, setMobileNumber] = useState("");
  const [parentMobileNumber, setParentMobileNumber] = useState("");
  const [email, setEmail] = useState("");

  const [EmailError, setEmailError] = useState("");
  const [NameError, setNameError] = useState("");

  const [isRegistering, setIsRegistering] = useState(false);
  const [registeredStudentName, setRegisteredStudentName] = useState<
    string | null
  >(null);

  const [isCheckingEmail, setIsCheckinEmail] =
  useState(false);
  
  const [isCheckingName, setIsCheckingName] =
  useState(false);

  const checkEmail = async (
    registrationNumber: string
  ) => {
    const regNo = registrationNumber.trim();

    if (!regNo) {
      setEmailError("");
      return;
    }

    try {

      setIsCheckinEmail(true);

      const response = await fetch(`/api/students/check-email?registrationNumber=${encodeURIComponent(regNo)}&teacherId=${encodeURIComponent(teacherId)}`
      );

      const result = await response.json();

      if (result.exists) {
        setEmailError("Email already exists.");
      } else {
        setEmailError("");
      }

      setIsCheckinEmail(false);

    } catch (error) {
      console.error(error);
    }
  };

  const checkName = async (
    registrationNumber: string
  ) => {
    const regNo = registrationNumber.trim();

    if (!regNo) {
      setNameError("");
      return;
    }

    try {

      setIsCheckingName(true);

      const response = await fetch(`/api/students/check-name?registrationNumber=${encodeURIComponent(regNo)}&teacherId=${encodeURIComponent(teacherId)}`
      );

      const result = await response.json();

      if (result.exists) {
        setNameError("Name already exists.");
      } else {
        setNameError("");
      }

      setIsCheckingName(false);

    } catch (error) {
      console.error(error);
    }
  };

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

    if (EmailError || NameError) return;

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

      if (!response.ok || result?.success === false) {
        const message =
          result?.error?.message ??
          result?.message ??
          "Registration failed. Please try again.";

        if (result?.error?.code === "EMAIL_EXISTS") {
          setEmailError(message);
        } else if (result?.error?.code === "NAME_EXISTS") {
          setNameError(message);
        } else {
          toast.error(message);
        }
        return;
      }

      toast.success("Registered! Check your email for login details.", {
        duration: 6000,
      });

      setRegisteredStudentName(studentName.trim());

      // Clear form
      setStudentName("");
      setMobileNumber("");
      setParentMobileNumber("");
      setEmail("");
      setSelectedGrade("");
      setEmailError("");
      setNameError("");
    } catch (error) {
      console.error(error);
      toast.error("Something went wrong. Please try again.");
    }

    setIsRegistering(false);
  }

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}

     <div className="relative overflow-hidden bg-gradient-to-r from-emerald-600 via-emerald-600 to-orange-500 px-5 py-3.5 text-white">

        {/* Decorative Circle */}

        <div className="absolute -right-8 -top-8 h-20 w-20 rounded-full bg-white/10" />
        <div className="absolute -right-3 bottom-2 h-10 w-10 rounded-full bg-white/10" />

        <div className="relative flex items-center gap-2.5">

          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/15 backdrop-blur-sm">
            <GraduationCap className="h-4 w-4 text-white" />
          </div>

          <div>
            <h2 className="text-[16px] font-bold text-white">
              Join This Class
            </h2>
            <p className="mt-0.5 text-[13px] text-emerald-50">
              Register in a few steps.
            </p>
          </div>

        </div>

      </div>

      {/* Form / success */}

      {registeredStudentName ? (
        <div className="space-y-3 p-5">
          <div className="flex items-start gap-2.5 rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            <div>
              <p className="text-[14px] font-semibold text-emerald-800">
                {registeredStudentName} registered successfully!
              </p>
              <p className="mt-0.5 text-[12px] leading-5 text-emerald-700">
                Your registration was received.
              </p>
            </div>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p className="text-[12px] leading-5 text-amber-800">
              You are now{" "}
              <span className="font-semibold">waiting for the teacher&apos;s confirmation</span>.
              You will be enrolled once they approve your request.
            </p>
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <Mail className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
            <p className="text-[12px] leading-5 text-slate-700">
              <span className="font-semibold">Check your email</span> for your login details.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setRegisteredStudentName(null)}
            className="w-full rounded-lg border border-slate-300 bg-white py-2 text-[13px] font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            Register another student
          </button>
        </div>
      ) : (
      <div className="space-y-2.5 p-5">

        <div>
          <label className="mb-1 block text-[13px] font-semibold text-slate-700">
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
              if (NameError) {
                setNameError("");
              }

              checkName(e.target.value);
            }}
            
            className={`w-full rounded-lg px-3 py-2 text-[14px] outline-none transition ${
              errors.studentName || NameError
                ? "border border-red-500 focus:border-red-500 focus:ring-red-500"
                : "border border-slate-300 focus:border-emerald-500 focus:ring-emerald-500"
            }`}
            placeholder="Enter student name"
          />
          {NameError && (
            <p className="mt-1 text-[12px] text-red-600">
              {NameError}
            </p>
          )}

        </div>

        {errors.studentName && (
          <p className="mt-1 text-[12px] text-red-600">
            {errors.studentName}
          </p>
        )}

        <div>
          <label className="mb-1 block text-[13px] font-semibold text-slate-700">
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
            className={`w-full rounded-lg px-3 py-2 text-[14px] outline-none transition
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
          <p className="mt-1 text-[12px] text-red-600">
            {errors.mobileNumber}
          </p>
        )}

        <div>
          <label className="mb-1 block text-[13px] font-semibold text-slate-700">
            Parent / Guardian Mobile Number
          </label>

          <input
            value={parentMobileNumber}
            onChange={(e) => setParentMobileNumber(e.target.value)}
            className={`w-full rounded-lg px-3 py-2 text-[14px] outline-none transition
                      ${
                        errors.parentMobileNumber
                          ? "border border-red-500 focus:border-red-500"
                          : "border border-slate-300 focus:border-emerald-500"
                      }`}
            placeholder="07XXXXXXXX"
          />
        </div>

        <div>
          <label className="mb-1 block text-[13px] font-semibold text-slate-700">
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
              if (EmailError) {
                setEmailError("");
              }

              checkEmail(e.target.value);
            }}
            className={`w-full rounded-lg px-3 py-2 text-[14px] outline-none transition ${
              errors.email || EmailError
                ? "border border-red-500 focus:border-red-500 focus:ring-red-500"
                : "border border-slate-300 focus:border-emerald-500 focus:ring-emerald-500"
            }`}
            placeholder="example@email.com"
          />
          {(EmailError || errors.email) && (
            <p className="mt-1 text-[12px] text-red-600">
              {EmailError || errors.email}
            </p>
          )}
        </div>


        {/* <div>
          <label className="mb-1 block text-[13px] font-semibold text-slate-700">
            School
          </label>

          <input
            className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none transition focus:border-emerald-500"
            placeholder="Your School"
          />
        </div> */}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-[13px] font-semibold text-slate-700">
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
            className={`w-full rounded-lg px-3 py-2 text-[14px] outline-none transition
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
          <p className="mt-1 text-[12px] text-red-600">
            {errors.grade}
          </p>
        )}

        {/* Buttons */}

        <button
          type="button"
          disabled={
            isRegistering ||
            isCheckingEmail ||
            isCheckingName ||
            !!EmailError ||
            !!NameError
          }
          onClick={registerStudent}
          className={`
            flex w-full items-center justify-center gap-2
            rounded-lg py-2.5 text-[14px] font-semibold text-white transition
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
            rounded-lg
            border
            border-orange-300
            bg-orange-50
            py-2.5
            text-[14px]
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
      )}

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

              <span className="text-[16px] text-slate-700">
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

          <p className="text-[13px] leading-5 text-slate-500">
            Your registration details are securely
            protected.
          </p>

        </div>

        {/* <div className="mt-4 flex items-center gap-3">

          <CreditCard className="h-5 w-5 text-orange-500" />

          <p className="text-[13px] leading-5 text-slate-500">
            Flexible monthly payments with no
            hidden charges.
          </p>

        </div> */}

      </div>

    </div>
  );
}