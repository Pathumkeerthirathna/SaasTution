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
    <div className="overflow-hidden rounded-xl border border-red-200 bg-white shadow-sm">

      {/* Header */}
      <div className="flex items-start gap-3 border-b border-red-200 bg-red-50 p-3.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-100 text-base">
          🚫
        </div>
        <div>
          <h2 className="text-[13px] font-bold text-slate-900">Device access rejected</h2>
          <p className="mt-0.5 text-[11px] leading-4 text-slate-600">
            Your teacher has rejected this device.
          </p>
        </div>
      </div>

      <div className="space-y-3 p-3.5">

        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
          <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Current device
          </h3>
          <p className="font-medium text-slate-800">{deviceApproval.currentDevice?.deviceName}</p>
          <p className="text-[11px] text-slate-500">
            {deviceApproval.currentDevice?.browser} • {deviceApproval.currentDevice?.os}
          </p>
        </div>

        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Your request
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
                className="text-[11px] font-semibold text-blue-600 hover:text-blue-800"
              >
                Edit
              </button>
            )}
          </div>

          {editingRequest ? (
            <>
              <textarea
                rows={4}
                value={requestMessage}
                onChange={(e) => setRequestMessage(e.target.value)}
                className="w-full rounded-md border border-slate-300 bg-white p-2.5 text-xs focus:border-emerald-500 focus:outline-none"
              />
              <div className="mt-2.5 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setEditingRequest(false);
                    setRequestMessage(
                      deviceApproval.currentDevice?.approvalRequestMessage ?? ""
                    );
                  }}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-[11px] font-medium text-slate-700 hover:bg-slate-100"
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
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:bg-slate-300"
                >
                  Update &amp; send request
                </button>
              </div>
            </>
          ) : (
            <p className="whitespace-pre-wrap rounded-md border border-blue-100 bg-white p-2.5 text-[11px] leading-4 text-slate-700">
              {deviceApproval.currentDevice?.approvalRequestMessage ??
                "You haven't submitted a request yet."}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Teacher&apos;s response
          </h3>
          <p className="mt-1 text-[11px] leading-4 text-slate-700">
            {deviceApproval.currentDevice?.rejectedReason ??
              "No reason was provided."}
          </p>
        </div>

        {/* Approved Devices */}
        {deviceApproval.approvedDevices && deviceApproval.approvedDevices.length > 0 && (
          <div>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Approved devices
            </h3>
            <div className="space-y-2">
              {deviceApproval.approvedDevices.map((device) => (
                <div
                  key={device.id}
                  className="rounded-lg border border-emerald-200 bg-emerald-50 p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-900">{device.deviceName}</p>
                      <p className="mt-0.5 text-[11px] text-slate-600">
                        {device.browser} • {device.os}
                      </p>
                      {device.lastLoginAt && (
                        <p className="mt-0.5 text-[10px] text-slate-500">
                          Last login: {new Date(device.lastLoginAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                      Approved
                    </span>
                  </div>
                  <p className="mt-2 rounded-md border border-green-100 bg-white p-2 text-[11px] leading-4 text-slate-700">
                    You can keep using this device while your teacher reviews the request.
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}