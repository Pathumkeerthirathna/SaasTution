import { apiError, apiSuccess } from "@/lib/api-response";
import { handleRouteError } from "@/lib/error-handler";
import { RegisterStudentViaPublicClasses } from "@/services/student-service";
import { RegisterStudentRequest } from "@/types/teacherProfileTypes/RegisterStudentRequest";

export async function POST(request: Request) {
    try {
        const body: RegisterStudentRequest = await request.json();

        const student = await RegisterStudentViaPublicClasses(body);

        return apiSuccess(
            { student },
            {
                status: 201,
                message: "Student registered successfully."
            }
        );
    } catch (error) {
        return handleRouteError(error);
    }
}