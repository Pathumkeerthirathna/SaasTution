"use client";

import { StudentClasses } from "@/app/student/Components/StudentClasses";
import { StudentProfileHeader } from "@/app/student/Components/StudentProfileHeader";
import { StudentProfileTabs } from "@/app/student/Components/StudentProfileTabs";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

interface StudentProfilePageProps {
  studentId: string;
}

export default function StudentProfilePage() {

  const params = useParams();
  const studentId = params.id as string;
  
  const [student, setStudent] = useState<any>(null);
  const [classes, setClasses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingClasses, setLoadingClasses] = useState(true);

  // useEffect(() => {
  //   loadStudent();
  // }, [studentId]);

  useEffect(() => {
    if (studentId) {
      loadPageData();
    }
  }, [studentId]);

  async function loadPageData() {
    try {
      setLoading(true);

      loadStudent();


      // const response = await fetch(
      //    `/api/student/Profile/${studentId}/classes`
      // );

      // const studentResult = await response.json();

      //   console.log("API response status:", studentResult.data);

      // if (studentResult.success) {
      //   setStudent(studentResult.data);
      // }

      // const [studentResponse] = await Promise.all([
      //   fetch(`/api/student/profile/${studentId}/classes`)
      // ]);

      // const studentResult = await studentResponse.json();

      // console.log(studentResult);

      // if (studentResult.success) {
      //   setStudent(studentResult.data);
      // }

      // const [classesResponse] = await Promise.all([
        
      //   fetch(`/api/student/profile/${studentId}/classes`)
      // ]);

      // const studentResult = await response.json();
      // const classesResult = await classesResponse.json();

      // console.log("Student API response:", studentResult);
      // console.log("Classes API response:", classesResult);

      // if (studentResult.success) {
      //   setStudent(studentResult.data);
      // }

      // if (classesResult.success) {
      //   setClasses(classesResult.data);
      // }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

  async function loadStudent() {
    try {
      setLoading(true);

      console.log("Loading student with ID:", studentId);

      const response = await fetch(
         `/api/student/Profile/${studentId}`
      );

      const result = await response.json();
       console.log("API response status:", result.data);

      if (result.success) {
        setStudent(result.data);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  }

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