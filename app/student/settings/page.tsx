import Link from "next/link";

import { Panel } from "@/components/student-portal/student-ui";

export default function StudentSettingsPage() {
  return (
    <Panel title="Settings" subtitle="Manage account and privacy settings.">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-medium text-slate-900">Password and account security</p>
          <p className="text-sm text-slate-600">Change your password and keep your account protected.</p>
        </div>
        <Link
          href="/account/security"
          className="inline-flex items-center justify-center rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white"
        >
          Open Security Settings
        </Link>
      </div>
    </Panel>
  );
}
