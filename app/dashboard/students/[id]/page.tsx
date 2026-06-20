"use client";

import { StudentProfileHeader } from "@/app/student/Components/StudentProfileHeader";
import { StudentProfileTabs } from "@/app/student/Components/StudentProfileTabs";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    message: string;
    code?: string;
  };
}

interface Student {
  id: string;
  name: string;
  contact: string;
  email: string | null;
  contact01: string | null;
  contact02: string | null;
  registrationNumber: string | null;
  gradeId: number | null;
  status: number;
  teacherId: string;
  createdAt: string;
  actionTakenDate: string | null;
  grade?: { name: string } | null;
  classes?: Array<{ classId: string }>;
  guardians?: Array<{ id: string }>;
}

export default function StudentProfilePage() {

  const params = useParams();
  const studentId = params.id as string;
  
  const [student, setStudent] = useState<Student | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStudent = useCallback(async () => {
    try {
      setLoading(true);

      console.log("Loading student with ID:", studentId);

      const response = await fetch(
         `/api/student/Profile/${studentId}`
      );

      const result: ApiResponse<Student> = await response.json();
      console.log("API response status:", result.data);

      if (result.success && result.data) {
        setStudent(result.data);
      }
    } catch (error) {
      console.error("Error loading student:", error);
    } finally {
      setLoading(false);
    }
  }, [studentId]);

  const loadPageData = useCallback(async () => {
    try {
      setLoading(true);
      await loadStudent();
    } catch (error) {
      console.error("Error loading page data:", error);
    } finally {
      setLoading(false);
    }
  }, [loadStudent]);

  // useEffect(() => {
  //   loadStudent();
  // }, [studentId]);

  useEffect(() => {
    if (studentId) {
      loadPageData();
    }
  }, [studentId, loadPageData]);

  if (loading) {
    return <div>Loading student...</div>;
  }

  if (!student) {
    return <div>Student not found</div>;
  }

  console.log("Student data:", student);

  return (
  <div className="space-y-1">
    
    <StudentProfileHeader student={student} />

    <StudentProfileTabs
      studentId={studentId}
    />
    
    {/* <StudentDetails student={student} /> */}
    {/* <StudentClasses classes={student.classes} /> */}

    

  </div>
);
}