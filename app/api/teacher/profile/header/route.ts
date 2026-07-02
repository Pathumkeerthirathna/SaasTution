import { requireTeacherSession } from "@/lib/auth-session";
import { updateTeacherProfile } from "@/services/teacher-profile-service";
import { UpdateTeacherProfile } from "@/types/teacherProfileTypes/UpdateTeacherProfile";

export async function PUT(request: Request) {

    const session = await requireTeacherSession();

    const body: UpdateTeacherProfile =
        await request.json();

    const teacherId = session.teacherId;

    const profile =
        await updateTeacherProfile(
            teacherId,
            body
        );

    return Response.json(profile);
}