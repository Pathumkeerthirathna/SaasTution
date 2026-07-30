import { useState } from "react";

  type DeviceApprovalData = {
    currentDevice?: {
      id: string;
      deviceName?: string;
      browser?: string;
      os?: string;
      rejectedReason?: string;
      approvalRequestMessage?: string;
      status:string
    };
    approvedDevices?: {
      id: string;
      deviceName?: string;
      browser?: string;
      os?: string;
      lastLoginAt?: string;
    }[];
    allowRequestAgain?: boolean;
  };

type RejectedDeviceCardProps = {
  deviceApproval: DeviceApprovalData;
  requestMessage: string;
  setRequestMessage: React.Dispatch<React.SetStateAction<string>>;
  onRequestAgain: () => Promise<boolean>;
  setDeviceApproval: React.Dispatch<
  React.SetStateAction<DeviceApprovalData | null>
>;
};

export function RejectedDeviceCard({
  deviceApproval,
  requestMessage,
  setRequestMessage,
  onRequestAgain,
  setDeviceApproval,
}: RejectedDeviceCardProps) {

  const [editingRequest, setEditingRequest] = useState(false);



  return (
    <div className="mt-6 overflow-hidden rounded-3xl border border-red-200 bg-white shadow-lg">

      {/* Header */}

      <div className="border-b border-red-200 bg-gradient-to-r from-red-50 to-rose-50 p-6">

        <div className="flex items-center gap-4">

          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-red-100">
            🚫
          </div>

          <div>

            <h2 className="text-xl font-bold">
              Device Access Rejected
            </h2>

            <p className="mt-1 text-sm text-slate-600">
              Your teacher has rejected this device.
            </p>

          </div>

        </div>

      </div>

      <div className="space-y-6 p-6">

        <div className="rounded-2xl border bg-slate-50 p-5">

          <h3 className="mb-3 font-semibold">
            Current Device
          </h3>

          <p>{deviceApproval.currentDevice?.deviceName}</p>

          <p className="text-sm text-slate-500">
            {deviceApproval.currentDevice?.browser}
          </p>

          <p className="text-sm text-slate-500">
            {deviceApproval.currentDevice?.os}
          </p>

        </div>

        <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5">

          <div className="mb-3 flex items-center justify-between">

            <h3 className="font-semibold text-slate-900">
              📝 Your Request
            </h3>

            {!editingRequest && (
              <button
                type="button"
                onClick={() => {
                  setRequestMessage(
                    deviceApproval.currentDevice?.approvalRequestMessage ?? ""
                  );
                  setEditingRequest(true);
                }}
                className="text-sm font-medium text-blue-600 hover:text-blue-800"
              >
                ✏️ Edit
              </button>
            )}

          </div>

          {editingRequest ? (

            <>
              <textarea
                rows={5}
                value={requestMessage}
                onChange={(e) => setRequestMessage(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white p-4 text-sm focus:border-emerald-500 focus:outline-none"
              />

              <div className="mt-4 flex justify-end gap-3">

                <button
                  type="button"
                  onClick={() => {
                    setEditingRequest(false);
                    setRequestMessage(
                      deviceApproval.currentDevice?.approvalRequestMessage ?? ""
                    );
                  }}
                  className="rounded-xl border border-slate-300 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={async () => {
                    const success = await onRequestAgain();

                    if (!success) return;

                    setDeviceApproval((prev) => {
                      if (!prev) return prev;

                      return {
                        ...prev,
                        currentDevice: {
                          ...prev.currentDevice!,
                          approvalRequestMessage: requestMessage,
                          status: "BLOCKED",
                        },
                      };
                    });

                    setEditingRequest(false);
                  }}
                  disabled={!requestMessage.trim()}
                  className="rounded-xl bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
                >
                  Update & Send Request
                </button>

              </div>
            </>

          ) : (

            <div className="rounded-xl border border-blue-100 bg-white p-4">

              <p className="whitespace-pre-wrap text-sm leading-6 text-slate-700">
                {deviceApproval.currentDevice?.approvalRequestMessage ??
                  "You haven't submitted a request yet."}
              </p>

            </div>

          )}

        </div>

        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">

          <h3 className="font-semibold">
            Teacher's Response
          </h3>

          <p className="mt-2 text-sm">
            {deviceApproval.currentDevice?.rejectedReason ??
              "No reason was provided."}
          </p>

        </div>


      </div>

      {/* Approved Devices */}

    {deviceApproval.approvedDevices &&
    deviceApproval.approvedDevices.length > 0 && (

    <div>

        <div className="mb-3 flex items-center gap-2">

        <span className="text-xl">💻</span>

        <h3 className="font-semibold text-slate-900">
            Approved Devices
        </h3>

        </div>

        <div className="space-y-4">

        {deviceApproval.approvedDevices.map((device) => (

            <div
            key={device.id}
            className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5"
            >

            <div className="flex items-start justify-between">

                <div>

                <h4 className="font-semibold text-slate-900">
                    {device.deviceName}
                </h4>

                <p className="mt-1 text-sm text-slate-600">
                    {device.browser} • {device.os}
                </p>

                {device.lastLoginAt && (
                    <p className="mt-2 text-xs text-slate-500">
                    Last login:
                    {" "}
                    {new Date(device.lastLoginAt).toLocaleString()}
                    </p>
                )}

                </div>

                <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">
                Approved
                </span>

            </div>

            <div className="mt-4 rounded-xl border border-green-100 bg-white p-4">

                <p className="text-sm text-slate-700">
                ✅ <strong>You can continue using this approved device</strong>{" "}
                while waiting for your teacher to review this device request.
                </p>

            </div>

            </div>

        ))}

        </div>

    </div>

    )}

    </div>
  );
}