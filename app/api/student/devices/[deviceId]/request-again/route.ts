import { apiSuccess } from "@/lib/api-response";
import { requestApprovalAgain } from "@/services/student-device.service";
import { NextRequest } from "next/server";

export async function PUT(
    request: NextRequest,
    { params }: { params: { deviceId: string } }
) {

    const body = await request.json();

    await requestApprovalAgain(
        params.deviceId,
        body.message
    );

    return apiSuccess(
        "Request submitted successfully."
    );

}