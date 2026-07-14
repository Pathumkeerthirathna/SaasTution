import {
  updateProfilePhoto,
} from "@/services/teacher-profile-service";
import { requireTeacherSession } from "@/lib/auth-session";
import { prisma } from "@/lib/prisma";

export async function GET() {
    const session = await requireTeacherSession();

    const profile = await prisma.teacherProfile.findUnique({
        where: {
            teacherId: session.teacherId,
        },
        select: {
            profileImageUrl: true,
        },
    });

    return Response.json({
        profileImageUrl:
            profile?.profileImageUrl ??
            "/images/avatar.png",
    });
}

export async function PUT(request: Request) {
  const form = await request.formData();

  const file = form.get("photo") as File;

  const session = await requireTeacherSession();

  if (!file) {
    return Response.json(
      { message: "Photo is required." },
      { status: 400 }
    );
  }

  const teacherId = session.teacherId; // your auth

  const teacher = await updateProfilePhoto(
    teacherId,
    file
  );

  return Response.json({
    profileImageUrl: teacher.profileImageUrl
});
}