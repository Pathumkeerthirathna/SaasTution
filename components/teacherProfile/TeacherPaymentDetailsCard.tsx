"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Building2, Check, Copy, Landmark, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import toast from "react-hot-toast";

import { useModalDialog } from "@/components/attendance/use-modal-dialog";
import SectionVisibilityToggle from "./SectionVisibilityToggle";
import type { OwnerPaymentAccount, PublishedPaymentAccount } from "@/services/teacher-payment-account-service";

/*
 * Payment Details on the teacher profile: a compact button in the profile
 * header that opens the Payment Details dialog.
 *
 *   mode "view"   - visitors and students: the PUBLISHED accounts the server
 *                   rendered into the page (no API call; nothing else is ever
 *                   sent to the browser). Read-only. No button at all when
 *                   the teacher published no account.
 *   mode "manage" - the profile owner only: the owner's own accounts from
 *                   /api/teacher/profile/payment-accounts (teacher session;
 *                   the server enforces ownership on every call), with add,
 *                   edit, delete, primary and per-account public / active
 *                   switches, and the "show Payment Details" master switch.
 *
 * Layering: Add / Edit open a SEPARATE form dialog above the main one. The
 * main dialog stays mounted (its list, scroll and state are kept) but its
 * modal behaviour - focus trap, Escape, backdrop - is handed to the form
 * dialog while the form is open (useModalDialog runs for the active layer
 * only). Escape or Cancel closes only the form; after a save the main dialog
 * reloads its list. Both dialogs are portalled to <body>, the form one
 * above.
 *
 * These are bank details for paying fees. They are not ClassPayment records,
 * receipts or payment confirmations.
 */

type AccountType = PublishedPaymentAccount["accountType"];

const TYPE_LABEL: Record<AccountType, string> = { SAVINGS: "Savings", CURRENT: "Current", OTHER: "Other" };

/** The header button (also where focus returns when a dialog closes and its trigger is gone). */
export const PAYMENT_DETAILS_BUTTON_ID = "payment-details-button";

type Props =
  | { mode: "view"; accounts: PublishedPaymentAccount[] }
  | { mode: "manage" };

/** The header button and its dialog. Visitors / students without published accounts get nothing. */
export default function TeacherPaymentDetailsButton(props: Props) {
  const [open, setOpen] = useState(false);
  if (props.mode === "view" && props.accounts.length === 0) return null;
  return (
    <>
      <button
        id={PAYMENT_DETAILS_BUTTON_ID}
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-[#4D6C90]/40 bg-white px-3 text-[12.5px] font-semibold text-[#112D5C] shadow-sm transition hover:bg-[#4D6C90]/5"
      >
        <Landmark className="pointer-events-none h-3.5 w-3.5" />
        <span className="pointer-events-none">Payment Details</span>
      </button>
      {open ? (
        props.mode === "manage" ? (
          <ManagePaymentDetails onClose={() => setOpen(false)} />
        ) : (
          <PaymentDialog
            layer="main"
            active
            titleId="payment-details-title"
            title="Payment Details"
            subtitle="Bank accounts published by the teacher for class fee payments."
            onClose={() => setOpen(false)}
            canClose={() => true}
          >
            <PublishedPaymentDetails accounts={props.accounts} />
          </PaymentDialog>
        )
      ) : null}
    </>
  );
}

// ---- The dialog shell (main and form layers) ----------------------------------------------------------------------

function PaymentDialog({
  layer,
  active,
  titleId,
  title,
  subtitle,
  headerAction,
  onClose,
  canClose,
  children,
}: {
  layer: "main" | "form";
  /** False while a dialog above this one is open: this one stays mounted but hands over focus, Escape and the backdrop. */
  active: boolean;
  titleId: string;
  title: React.ReactNode;
  subtitle?: string;
  headerAction?: React.ReactNode;
  onClose: () => void;
  canClose: () => boolean;
  children: React.ReactNode;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalDialog({ open: active, dialogRef, overlayRef, canClose, onClose, fallbackId: PAYMENT_DETAILS_BUTTON_ID });

  // The page behind does not scroll while the main dialog is open.
  useEffect(() => {
    if (layer !== "main") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [layer]);

  return createPortal(
    <div
      ref={overlayRef}
      data-payment-dialog={layer}
      data-active={active ? "true" : "false"}
      className={`fixed inset-0 flex items-end justify-center p-0 sm:items-center sm:p-4 ${layer === "form" ? "z-[1010] bg-slate-900/30" : "z-[1000] bg-slate-900/40"}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && active && canClose()) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl outline-none sm:rounded-2xl ${layer === "form" ? "sm:max-w-xl" : "sm:max-w-2xl"}`}
      >
        <div className="flex items-start gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="flex items-center gap-2 text-[16px] font-bold text-slate-900">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-[13.5px] text-slate-500">{subtitle}</p> : null}
          </div>
          {headerAction}
          <button
            type="button"
            onClick={() => canClose() && onClose()}
            className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
            data-autofocus={layer === "main" && !headerAction ? "" : undefined}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

// ---- Shared pieces -------------------------------------------------------------------------------------------

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy. Select the number and copy it manually.");
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[12px] font-semibold text-slate-600 transition hover:bg-slate-50"
      aria-label="Copy account number"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function AccountDetails({ account, large }: { account: PublishedPaymentAccount; large?: boolean }) {
  return (
    <dl className={`grid grid-cols-1 gap-x-6 gap-y-2 ${large ? "sm:grid-cols-2" : ""} text-[14px]`}>
      <div className="min-w-0">
        <dt className="text-[12px] font-medium uppercase tracking-wide text-slate-400">Account holder</dt>
        <dd className="break-words font-semibold text-slate-800">{account.accountHolderName}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-[12px] font-medium uppercase tracking-wide text-slate-400">Bank</dt>
        <dd className="break-words text-slate-800">
          {account.bankName}
          {account.branchName ? <span className="text-slate-500"> – {account.branchName}</span> : null}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-[12px] font-medium uppercase tracking-wide text-slate-400">Account number</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span className={`break-all font-mono ${large ? "text-[17px]" : "text-[15px]"} font-semibold tracking-wide text-slate-900`}>{account.accountNumber}</span>
          <CopyButton value={account.accountNumber} />
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-[12px] font-medium uppercase tracking-wide text-slate-400">Account type</dt>
        <dd className="text-slate-800">{TYPE_LABEL[account.accountType]}</dd>
      </div>
    </dl>
  );
}

// ---- View (visitors and students) --------------------------------------------------------------------------------

/** The published accounts, read-only: the primary highlighted, the others separate. */
export function PublishedPaymentDetails({ accounts }: { accounts: PublishedPaymentAccount[] }) {
  const primary = accounts.find((account) => account.isPrimary) ?? null;
  const others = accounts.filter((account) => account !== primary);
  return (
    <div>
      {primary ? (
        <div className="rounded-xl border border-[#4D6C90]/30 bg-[#4D6C90]/5 p-4" data-account="primary">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-[#112D5C] px-2.5 py-0.5 text-[12px] font-semibold text-white">
              <Star className="h-3 w-3" /> Primary account
            </span>
            {primary.label ? <span className="break-words text-[14px] font-semibold text-slate-700">{primary.label}</span> : null}
          </div>
          <AccountDetails account={primary} large />
        </div>
      ) : null}

      {others.length > 0 ? (
        <div className={primary ? "mt-5" : ""}>
          {primary ? <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-slate-500">Other accounts</h3> : null}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {others.map((account, index) => (
              <div key={`${account.bankName}-${account.accountNumber}-${index}`} className="rounded-lg border border-slate-200 p-4" data-account="other">
                {account.label ? <p className="mb-2 break-words text-[14px] font-semibold text-slate-700">{account.label}</p> : null}
                <AccountDetails account={account} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <p className="mt-4 text-[13px] text-slate-500">Keep your payment receipt and upload it from the Payments page of the student portal.</p>
    </div>
  );
}

// ---- Manage (the profile owner) -------------------------------------------------------------------------------

type FormState = {
  label: string;
  accountHolderName: string;
  bankName: string;
  branchName: string;
  accountNumber: string;
  accountType: AccountType;
  isPublic: boolean;
  isActive: boolean;
  isPrimary: boolean;
};

const EMPTY_FORM: FormState = {
  label: "",
  accountHolderName: "",
  bankName: "",
  branchName: "",
  accountNumber: "",
  accountType: "SAVINGS",
  isPublic: true,
  isActive: true,
  isPrimary: false,
};

type ApiBody<T> = { success: true; data: T } | { success: false; error?: { message?: string } };

async function callApi<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => null)) as ApiBody<T> | null;
  if (!response.ok || !body || body.success !== true) {
    throw new Error((body && body.success === false && body.error?.message) || "Something went wrong. Please try again.");
  }
  return body.data;
}

const ENDPOINT = "/api/teacher/profile/payment-accounts";

/** The owner's main Payment Details dialog, and the Add / Edit form dialog layered above it. */
function ManagePaymentDetails({ onClose }: { onClose: () => void }) {
  const [accounts, setAccounts] = useState<OwnerPaymentAccount[] | null>(null);
  const [visible, setVisible] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; form: FormState } | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setAccounts(await callApi<OwnerPaymentAccount[]>(ENDPOINT));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Couldn't load payment accounts.");
    }
  }, []);

  useEffect(() => {
    void reload();
    callApi<{ isDisplayPaymentDetails: boolean }>("/api/teacher/profile/section-visibility")
      .then((visibility) => setVisible(visibility.isDisplayPaymentDetails))
      .catch(() => setVisible(true));
  }, [reload]);

  const startAdd = () => setEditing({ id: null, form: { ...EMPTY_FORM, isPrimary: (accounts?.length ?? 0) === 0 } });
  const startEdit = (account: OwnerPaymentAccount) =>
    setEditing({
      id: account.id,
      form: {
        label: account.label ?? "",
        accountHolderName: account.accountHolderName,
        bankName: account.bankName,
        branchName: account.branchName ?? "",
        accountNumber: account.accountNumber,
        accountType: account.accountType,
        isPublic: account.isPublic,
        isActive: account.isActive,
        isPrimary: account.isPrimary,
      },
    });

  async function save() {
    if (!editing || saving) return;
    const { id, form } = editing;
    const original = id ? accounts?.find((account) => account.id === id) : undefined;
    const payload: Record<string, unknown> = {
      label: form.label.trim() || null,
      accountHolderName: form.accountHolderName,
      bankName: form.bankName,
      branchName: form.branchName.trim() || null,
      accountNumber: form.accountNumber,
      accountType: form.accountType,
      isPublic: form.isPublic,
      isActive: form.isActive,
    };
    // The primary can be moved TO an account; it is never switched off directly.
    if (!id || (form.isPrimary && !original?.isPrimary)) payload.isPrimary = form.isPrimary;
    setSaving(true);
    try {
      await callApi(id ? `${ENDPOINT}/${encodeURIComponent(id)}` : ENDPOINT, { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) });
      toast.success(id ? "Bank account updated." : "Bank account added.");
      setEditing(null); // back to the main dialog
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save the bank account.");
    } finally {
      setSaving(false);
    }
  }

  async function act(account: OwnerPaymentAccount, action: "primary" | "delete" | "public" | "active") {
    if (busyId) return;
    if (action === "delete" && !window.confirm(`Remove the ${account.bankName} account ending ${account.accountNumber.slice(-4)}?`)) return;
    setBusyId(account.id);
    try {
      const base = `${ENDPOINT}/${encodeURIComponent(account.id)}`;
      if (action === "primary") await callApi(`${base}/primary`, { method: "POST" });
      else if (action === "delete") await callApi(base, { method: "DELETE" });
      else if (action === "public") await callApi(base, { method: "PATCH", body: JSON.stringify({ isPublic: !account.isPublic }) });
      else await callApi(base, { method: "PATCH", body: JSON.stringify({ isActive: !account.isActive }) });
      toast.success(action === "primary" ? "Primary account changed." : action === "delete" ? "Bank account removed." : "Bank account updated.");
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't update the bank account.");
    } finally {
      setBusyId(null);
    }
  }

  const formOpen = editing !== null;

  return (
    <>
      <PaymentDialog
        layer="main"
        active={!formOpen}
        titleId="payment-details-title"
        title={
          <>
            <Landmark className="h-4 w-4 shrink-0 text-[#4D6C90]" /> Payment Details
          </>
        }
        subtitle="Bank accounts students and parents can use to pay your class fees. Only accounts marked Public are shown on your profile."
        onClose={onClose}
        canClose={() => busyId === null}
        headerAction={
          <button
            type="button"
            onClick={startAdd}
            data-autofocus=""
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-[#112D5C] px-2.5 text-[12.5px] font-semibold text-white shadow-sm transition hover:bg-[#0c2148]"
          >
            <Plus className="h-3.5 w-3.5" /> Add bank account
          </button>
        }
      >
        {visible !== null ? (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-slate-800">Show Payment Details on my public profile</p>
              <p className="text-[13px] text-slate-500">
                {visible ? "Public accounts are visible to visitors and students." : "All payment details are hidden from visitors and students."}
              </p>
            </div>
            <SectionVisibilityToggle section="paymentDetails" initialVisible={visible} onChange={setVisible} />
          </div>
        ) : null}

        {loadError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-[14px] text-red-700">{loadError}</p>
        ) : accounts === null ? (
          <p className="text-[14px] text-slate-500">Loading bank accounts…</p>
        ) : accounts.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center" data-empty-state="payment-accounts">
            <Landmark className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-2 text-[15px] font-semibold text-slate-700">No bank accounts yet</p>
            <p className="mt-1 text-[14px] text-slate-500">
              Add the bank account students and parents should pay your class fees into. You can add more than one and choose a primary account.
            </p>
          </div>
        ) : (
          <ul className="space-y-3" data-account-list="">
            {accounts.map((account) => (
              <li
                key={account.id}
                data-account-id={account.id}
                className={`rounded-lg border p-4 ${account.isPrimary ? "border-[#4D6C90]/40 bg-[#4D6C90]/5" : "border-slate-200"} ${account.isActive ? "" : "opacity-75"}`}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  {account.isPrimary ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#112D5C] px-2.5 py-0.5 text-[12px] font-semibold text-white">
                      <Star className="h-3 w-3" /> Primary
                    </span>
                  ) : null}
                  <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${account.isPublic ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                    {account.isPublic ? "Public" : "Private"}
                  </span>
                  {account.isActive ? null : <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[12px] font-semibold text-amber-700">Inactive</span>}
                  {account.label ? <span className="break-words text-[14px] font-semibold text-slate-700">{account.label}</span> : null}
                </div>
                <AccountDetails account={account} />
                <div className="mt-3 flex flex-wrap gap-2">
                  <ActionButton onClick={() => startEdit(account)} disabled={busyId !== null} icon={<Pencil className="h-3 w-3" />}>Edit</ActionButton>
                  {account.isPrimary ? null : (
                    <ActionButton onClick={() => act(account, "primary")} disabled={busyId !== null} icon={<Star className="h-3 w-3" />}>Make primary</ActionButton>
                  )}
                  <ActionButton onClick={() => act(account, "public")} disabled={busyId !== null}>{account.isPublic ? "Make private" : "Make public"}</ActionButton>
                  <ActionButton onClick={() => act(account, "active")} disabled={busyId !== null}>{account.isActive ? "Deactivate" : "Activate"}</ActionButton>
                  <ActionButton onClick={() => act(account, "delete")} disabled={busyId !== null} danger icon={<Trash2 className="h-3 w-3" />}>Delete</ActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PaymentDialog>

      {editing ? (
        <PaymentDialog
          layer="form"
          active
          titleId="payment-account-form-title"
          title={
            <>
              <Building2 className="h-4 w-4 text-[#4D6C90]" /> {editing.id === null ? "Add bank account" : "Edit bank account"}
            </>
          }
          onClose={() => setEditing(null)}
          canClose={() => !saving}
        >
          <AccountForm
            isNew={editing.id === null}
            isCurrentPrimary={Boolean(editing.id && accounts?.find((account) => account.id === editing.id)?.isPrimary)}
            form={editing.form}
            saving={saving}
            onChange={(form) => setEditing({ ...editing, form })}
            onCancel={() => setEditing(null)}
            onSave={save}
          />
        </PaymentDialog>
      ) : null}
    </>
  );
}

function ActionButton({ children, onClick, disabled, danger, icon }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[12.5px] font-semibold transition disabled:opacity-50 ${
        danger ? "border-red-200 text-red-700 hover:bg-red-50" : "border-slate-200 text-slate-700 hover:bg-slate-50"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

function AccountForm({
  isNew,
  isCurrentPrimary,
  form,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  isNew: boolean;
  isCurrentPrimary: boolean;
  form: FormState;
  saving: boolean;
  onChange: (form: FormState) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => onChange({ ...form, [key]: value });
  const input = "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-[14px] text-slate-900 focus:border-[#4D6C90] focus:outline-none focus:ring-1 focus:ring-[#4D6C90]";
  return (
    <form
      data-payment-account-form=""
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-[13px] font-medium text-slate-700">
          Account holder name *
          <input className={input} value={form.accountHolderName} maxLength={120} required data-autofocus="" onChange={(e) => set("accountHolderName", e.target.value)} />
        </label>
        <label className="text-[13px] font-medium text-slate-700">
          Bank name *
          <input className={input} value={form.bankName} maxLength={120} required onChange={(e) => set("bankName", e.target.value)} />
        </label>
        <label className="text-[13px] font-medium text-slate-700">
          Branch name
          <input className={input} value={form.branchName} maxLength={120} onChange={(e) => set("branchName", e.target.value)} />
        </label>
        <label className="text-[13px] font-medium text-slate-700">
          Account number *
          <input className={input} value={form.accountNumber} maxLength={34} inputMode="numeric" required onChange={(e) => set("accountNumber", e.target.value)} />
        </label>
        <label className="text-[13px] font-medium text-slate-700">
          Account type
          <select className={input} value={form.accountType} onChange={(e) => set("accountType", e.target.value as AccountType)}>
            <option value="SAVINGS">Savings</option>
            <option value="CURRENT">Current</option>
            <option value="OTHER">Other</option>
          </select>
        </label>
        <label className="text-[13px] font-medium text-slate-700">
          Display name (optional)
          <input className={input} value={form.label} maxLength={60} placeholder="e.g. Class fees" onChange={(e) => set("label", e.target.value)} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[13.5px] text-slate-700">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={form.isPublic} onChange={(e) => set("isPublic", e.target.checked)} />
          Show on my public profile
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set("isActive", e.target.checked)} />
          Active
        </label>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={form.isPrimary} disabled={isCurrentPrimary} onChange={(e) => set("isPrimary", e.target.checked)} />
          Primary account{isCurrentPrimary ? " (choose another account to change)" : ""}
        </label>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={saving} className="rounded-md border border-slate-200 px-3 py-1.5 text-[13px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">
          Cancel
        </button>
        <button type="submit" disabled={saving} className="rounded-md bg-[#112D5C] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[#0c2148] disabled:opacity-60">
          {saving ? "Saving…" : isNew ? "Add bank account" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
