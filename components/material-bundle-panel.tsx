"use client";

import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FileText,
  Files,
  GraduationCap,
  Plus,
  MoreHorizontal,
  Send,
  Trash2,
  Users,
  X,
} from "lucide-react";

type ClassItem = {
  id: string;
  name: string;
};

type BundleListItem = {
  id: string;
  classId: string;
  title: string;
  year: number;
  month: number;
  status: "DRAFT" | "SENT";
  sentAt: string | null;
  createdAt: string;
  class: ClassItem;
  _count: {
    items: number;
    recipients: number;
  };
};

type BundleItem = {
  id: string;
  type: "TUTE" | "PAPER";
  title: string;
  description: string | null;
  fileName: string | null;
  fileUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  paperStartAt: string | null;
  paperEndAt: string | null;
  createdAt: string;
};

type BundleStudentOption = {
  id: string;
  name: string;
  registrationNumber: string | null;
};

type BundleStudent = {
  id: string;
  name: string;
  registrationNumber: string | null;
  willReceive: boolean;
  receivedAt: string | null;
};

type BundleDetail = {
  id: string;
  classId: string;
  className: string;
  title: string;
  year: number;
  month: number;
  status: "DRAFT" | "SENT";
  sentAt: string | null;
  createdAt: string;
  items: BundleItem[];
  students: BundleStudent[];
  hasRecipientSelections: boolean;
  summary: {
    totalStudents: number;
    willReceiveCount: number;
    willNotReceiveCount: number;
  };
};

type Pagination = {
  page: number;
  totalPages: number;
};

type ApiError = {
  error?: {
    message?: string;
  };
  message?: string;
};




function readApiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const typed = payload as ApiError;
  return typed.error?.message ?? typed.message ?? fallback;
}

function monthLabel(month: number) {
  return new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "long" });
}

const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];


export function MaterialBundlePanel() {
  const now = new Date();

  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [bundles, setBundles] = useState<BundleListItem[]>([]);

  const [filterClassId, setFilterClassId] = useState("");
  const [filterYear, setFilterYear] = useState("");
  const [filterMonth, setFilterMonth] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [bundleDetail, setBundleDetail] = useState<BundleDetail | null>(null);

  // ── "Add class bundle" wizard ──────────────────────────────────────────
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<"details" | "items">("details");
  const [wzBundleId, setWzBundleId] = useState<string | null>(null);

  const [wzClassId, setWzClassId] = useState("");
  const [wzTitle, setWzTitle] = useState("");
  const [wzYear, setWzYear] = useState(String(now.getFullYear()));
  const [wzMonth, setWzMonth] = useState(String(now.getMonth() + 1));

  const [wzItems, setWzItems] = useState<BundleItem[]>([]);
  const [wzPopover, setWzPopover] = useState<null | "TUTE" | "PAPER">(null);
  const [wzItemTitle, setWzItemTitle] = useState("");
  const [wzItemDescription, setWzItemDescription] = useState("");
  const [wzItemFile, setWzItemFile] = useState<File | null>(null);
  const [wzPaperStart, setWzPaperStart] = useState("");
  const [wzPaperEnd, setWzPaperEnd] = useState("");

  const [wzStudents, setWzStudents] = useState<BundleStudentOption[]>([]);
  const [wzStudentSel, setWzStudentSel] = useState<Record<string, boolean>>({});
  const [wzLoadingStudents, setWzLoadingStudents] = useState(false);
  const [wzSaving, setWzSaving] = useState(false);
  const [wzError, setWzError] = useState<string | null>(null);

  const [recipientSelection, setRecipientSelection] = useState<Record<string, boolean>>({});
  const [isRecipientPanelOpen, setIsRecipientPanelOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);

  const currentYear = now.getFullYear();
  const yearOptions = Array.from({ length: 6 }, (_, index) => currentYear - index);

  const [isLoading, setIsLoading] = useState(false);
  const [, setIsLoadingDetails] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    async function loadClasses() {
      const response = await fetch("/api/classes?page=1&pageSize=100", { cache: "no-store" });
      const payload = (await response.json()) as {
        success: boolean;
        data?: ClassItem[];
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load classes."));
      }

      setClasses(payload.data ?? []);
    }

    void loadClasses().catch((error) => {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load classes.");
    });
  }, []);

  useEffect(() => {
    if (!isActionMenuOpen) return;

    function handleOutsideClick(event: MouseEvent) {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setIsActionMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsActionMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isActionMenuOpen]);


  async function loadBundles(nextPage = page) {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const qs = new URLSearchParams({
        page: String(nextPage),
        pageSize: "4",
      });

      if (filterClassId) qs.set("classId", filterClassId);
      if (filterYear.trim()) qs.set("year", filterYear.trim());
      if (filterMonth.trim()) qs.set("month", filterMonth.trim());

      const response = await fetch(`/api/material-bundles?${qs.toString()}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        success: boolean;
        data?: BundleListItem[];
        pagination?: Pagination;
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load bundles."));
      }

      const list = payload.data ?? [];
      setBundles(list);
      setPage(nextPage);
      setTotalPages(payload.pagination?.totalPages ?? 1);

      const stillSelected = selectedBundleId && list.some((b) => b.id === selectedBundleId);
      if (!stillSelected) {
        const nextId = list[0]?.id ?? null;
        setSelectedBundleId(nextId);
        if (nextId) {
          await loadBundleDetails(nextId);
        } else {
          setBundleDetail(null);
        }
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load bundles.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadBundles(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterClassId, filterYear, filterMonth]);

  async function loadBundleDetails(bundleId: string) {
    setIsLoadingDetails(true);

    try {
      const response = await fetch(`/api/material-bundles/${bundleId}`, { cache: "no-store" });
      const payload = (await response.json()) as {
        success: boolean;
        data?: {
          bundle: BundleDetail;
        };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle) {
        throw new Error(readApiError(payload, "Failed to load bundle details."));
      }

      setBundleDetail(payload.data.bundle);
      setSelectedBundleId(bundleId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load bundle details.");
    } finally {
      setIsLoadingDetails(false);
    }
  }

  function openWizard() {
    setWizardStep("details");
    setWzBundleId(null);
    setWzClassId(classes[0]?.id ?? "");
    setWzTitle("");
    setWzYear(String(now.getFullYear()));
    setWzMonth(String(now.getMonth() + 1));
    setWzItems([]);
    setWzPopover(null);
    setWzItemTitle("");
    setWzItemDescription("");
    setWzItemFile(null);
    setWzPaperStart("");
    setWzPaperEnd("");
    setWzStudents([]);
    setWzStudentSel({});
    setWzError(null);
    setIsWizardOpen(true);
  }

  async function wizardCreateBundle() {
    if (!wzClassId) {
      setWzError("Select a class.");
      return;
    }
    if (wzTitle.trim().length < 2) {
      setWzError("Bundle title must be at least 2 characters.");
      return;
    }

    setWzSaving(true);
    setWzError(null);

    try {
      const response = await fetch("/api/material-bundles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId: wzClassId,
          title: wzTitle.trim(),
          year: Number(wzYear),
          month: Number(wzMonth),
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: { bundle: { id: string } };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle?.id) {
        throw new Error(readApiError(payload, "Failed to create bundle."));
      }

      setWzBundleId(payload.data.bundle.id);
      setWizardStep("items");
      void wizardLoadStudents();
    } catch (error) {
      setWzError(error instanceof Error ? error.message : "Failed to create bundle.");
    } finally {
      setWzSaving(false);
    }
  }

  async function wizardLoadStudents() {
    if (!wzClassId) return;

    setWzLoadingStudents(true);

    try {
      const qs = new URLSearchParams({
        classId: wzClassId,
        year: wzYear,
        month: wzMonth,
      });

      const response = await fetch(
        `/api/material-bundles/class-students?${qs.toString()}`,
        { cache: "no-store" }
      );

      const payload = (await response.json()) as {
        success: boolean;
        data?: { students: BundleStudentOption[] };
      };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to load class students."));
      }

      const list = payload.data?.students ?? [];
      setWzStudents(list);
      setWzStudentSel(Object.fromEntries(list.map((student) => [student.id, true])));
    } catch (error) {
      setWzError(error instanceof Error ? error.message : "Failed to load class students.");
    } finally {
      setWzLoadingStudents(false);
    }
  }

  async function wizardAddItem() {
    if (!wzBundleId || !wzPopover) return;

    if (wzItemTitle.trim().length < 2) {
      setWzError("Item title must be at least 2 characters.");
      return;
    }
    if (wzPopover === "PAPER" && (!wzPaperStart || !wzPaperEnd)) {
      setWzError("Paper start and end time are required.");
      return;
    }

    setWzSaving(true);
    setWzError(null);

    try {
      const formData = new FormData();
      formData.set("type", wzPopover);
      formData.set("title", wzItemTitle.trim());
      if (wzItemDescription.trim()) formData.set("description", wzItemDescription.trim());
      if (wzPopover === "PAPER") {
        formData.set("paperStartAt", wzPaperStart);
        formData.set("paperEndAt", wzPaperEnd);
      }
      if (wzItemFile) formData.set("file", wzItemFile);

      const response = await fetch(`/api/material-bundles/${wzBundleId}/items`, {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: { item: BundleItem };
      };

      if (!response.ok || !payload.success || !payload.data?.item) {
        throw new Error(readApiError(payload, "Failed to add item."));
      }

      const item = payload.data.item;
      setWzItems((prev) => [...prev, item]);
      setWzPopover(null);
      setWzItemTitle("");
      setWzItemDescription("");
      setWzItemFile(null);
      setWzPaperStart("");
      setWzPaperEnd("");
    } catch (error) {
      setWzError(error instanceof Error ? error.message : "Failed to add item.");
    } finally {
      setWzSaving(false);
    }
  }

  async function wizardRemoveItem(itemId: string) {
    if (!wzBundleId) return;

    setWzSaving(true);
    setWzError(null);

    try {
      const response = await fetch(
        `/api/material-bundles/${wzBundleId}/items/${itemId}`,
        { method: "DELETE" }
      );
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to remove item."));
      }

      setWzItems((prev) => prev.filter((item) => item.id !== itemId));
    } catch (error) {
      setWzError(error instanceof Error ? error.message : "Failed to remove item.");
    } finally {
      setWzSaving(false);
    }
  }

  async function wizardSubmit() {
    if (!wzBundleId) return;

    setWzSaving(true);
    setWzError(null);

    try {
      const selectedStudentIds = Object.entries(wzStudentSel)
        .filter(([, selected]) => selected)
        .map(([id]) => id);

      const response = await fetch(`/api/material-bundles/${wzBundleId}/recipients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selectedStudentIds }),
      });

      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to save recipients."));
      }

      setIsWizardOpen(false);
      setSuccessMessage("Bundle created and sent to the selected students.");
      await loadBundles(1);
    } catch (error) {
      setWzError(error instanceof Error ? error.message : "Failed to save recipients.");
    } finally {
      setWzSaving(false);
    }
  }

  function openRecipientPanel() {
    if (!bundleDetail) return;

    const selection: Record<string, boolean> = {};
    for (const student of bundleDetail.students) {
      selection[student.id] = bundleDetail.hasRecipientSelections ? student.willReceive : true;
    }
    setRecipientSelection(selection);
    setIsRecipientPanelOpen(true);
  }

  async function saveRecipientsAndSend() {
    if (!selectedBundleId) return;

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const selectedStudentIds = Object.entries(recipientSelection)
        .filter(([, selected]) => selected)
        .map(([id]) => id);

      const response = await fetch(`/api/material-bundles/${selectedBundleId}/recipients`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ selectedStudentIds }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: { bundle: BundleDetail };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle) {
        throw new Error(readApiError(payload, "Failed to save recipients."));
      }

      setIsRecipientPanelOpen(false);
      setBundleDetail(payload.data.bundle);
      setBundles((prev) =>
        prev.map((bundle) =>
          bundle.id === selectedBundleId
            ? {
                ...bundle,
                status: payload.data?.bundle.status ?? bundle.status,
                sentAt: payload.data?.bundle.sentAt ?? bundle.sentAt,
                _count: {
                  ...bundle._count,
                  recipients: payload.data?.bundle.summary.willReceiveCount ?? bundle._count.recipients,
                },
              }
            : bundle
        )
      );
      setSuccessMessage("Bundle sent with selected recipients.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to save recipients.");
    } finally {
      setIsSaving(false);
    }
  }

  const wzMonthLabel = `${monthLabel(Number(wzMonth))} ${wzYear}`;
  const wzSelectedCount = Object.values(wzStudentSel).filter(Boolean).length;

  return (
    <div className="px-0 py-1 sm:py-0">


      {errorMessage ? (
        <p className="notice-error mt-4">{errorMessage}</p>
      ) : null}
      {successMessage ? (
        <p className="notice-success mt-4">
          {successMessage}
        </p>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[340px_minmax(0,1fr)] 2xl:grid-cols-[360px_minmax(0,1fr)]">
        <aside className="self-start xl:sticky xl:top-4 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto scrollbar-thin">
          {/* Filters — class / year / month tile pickers */}
          <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              {/* Class */}
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Class</p>
                <div className="scrollbar-thin max-h-[220px] space-y-1 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-1.5">
                  <button
                    type="button"
                    onClick={() => setFilterClassId("")}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                      filterClassId === ""
                        ? "bg-teal-600 text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-teal-50"
                    }`}
                  >
                    <BookOpen size={12} className={filterClassId === "" ? "text-white" : "text-slate-400"} />
                    <span className="truncate">All classes</span>
                  </button>
                  {classes.map((item) => {
                    const selected = item.id === filterClassId;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setFilterClassId(item.id)}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-semibold transition ${
                          selected
                            ? "bg-teal-600 text-white shadow-sm"
                            : "bg-white text-slate-600 hover:bg-teal-50"
                        }`}
                      >
                        <BookOpen size={12} className={selected ? "text-white" : "text-slate-400"} />
                        <span className="truncate">{item.name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Year */}
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Year</p>
                <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1.5">
                  <button
                    type="button"
                    onClick={() => setFilterYear("")}
                    className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                      filterYear === ""
                        ? "bg-teal-600 text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-teal-50"
                    }`}
                  >
                    All
                  </button>
                  {yearOptions.map((option) => {
                    const selected = filterYear === String(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setFilterYear(String(option))}
                        className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                          selected
                            ? "bg-teal-600 text-white shadow-sm"
                            : "bg-white text-slate-600 hover:bg-teal-50"
                        }`}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Month — 4 per row */}
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Month</p>
                <div className="grid grid-cols-4 gap-1.5 rounded-lg border border-slate-200 bg-slate-50 p-1.5">
                  <button
                    type="button"
                    onClick={() => setFilterMonth("")}
                    className={`col-span-4 rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                      filterMonth === ""
                        ? "bg-teal-600 text-white shadow-sm"
                        : "bg-white text-slate-600 hover:bg-teal-50"
                    }`}
                  >
                    All months
                  </button>
                  {MONTHS_SHORT.map((label, index) => {
                    const value = index + 1;
                    const selected = filterMonth === String(value);
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => setFilterMonth(String(value))}
                        className={`rounded-md px-2 py-1.5 text-xs font-semibold transition ${
                          selected
                            ? "bg-teal-600 text-white shadow-sm"
                            : "bg-white text-slate-600 hover:bg-teal-50"
                        }`}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

        </aside>

        <div className="self-start">
          {/* Bundle list */}
          <section className="flex flex-col rounded-xl border border-slate-200 bg-white p-3 shadow-sm xl:h-[calc(100vh-6rem)]">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Bundle List</p>
              <div className="flex items-center gap-2">
                <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-teal-100 px-2 text-[11px] font-semibold text-teal-700">
                  {bundles.length}
                </span>
                <button
                  type="button"
                  onClick={openWizard}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-teal-600 px-3 text-xs font-semibold text-white transition hover:bg-teal-700"
                >
                  <Plus size={14} />
                  New bundle
                </button>
                <div className="relative shrink-0" ref={actionMenuRef}>
                  <button
                    type="button"
                    onClick={() => setIsActionMenuOpen((prev) => !prev)}
                    aria-label="Open actions menu"
                    aria-expanded={isActionMenuOpen}
                    className="btn-secondary h-8 w-8 rounded-lg p-0"
                  >
                    <MoreHorizontal size={16} />
                  </button>

                  {isActionMenuOpen ? (
                    <div className="absolute right-0 z-20 mt-2 w-56 rounded-2xl border border-brand-100 bg-white p-2 shadow-card">
                      <button
                        type="button"
                        onClick={() => {
                          setIsActionMenuOpen(false);
                          openRecipientPanel();
                        }}
                        disabled={!bundleDetail}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-brand-50 disabled:opacity-40"
                      >
                        <Send size={16} />
                        Set recipients &amp; send
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsActionMenuOpen(false);
                          setIsHelpOpen(true);
                        }}
                        className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-brand-50"
                      >
                        <CircleHelp size={16} />
                        Help
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsActionMenuOpen(false);
                          openWizard();
                        }}
                        className="mt-1 flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-brand-50"
                      >
                        <Plus size={16} />
                        New bundle
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            {isLoading ? <p className="px-1 pb-2 text-xs font-medium text-slate-400">Loading...</p> : null}
            <div className="scrollbar-thin grid flex-1 auto-rows-min gap-2 overflow-y-auto pr-1 sm:grid-cols-2 2xl:grid-cols-3">
              {bundles.map((bundle) => {
                const selected = selectedBundleId === bundle.id;
                return (
                  <button
                    key={bundle.id}
                    type="button"
                    onClick={() => void loadBundleDetails(bundle.id)}
                    className={`rounded-lg px-3 py-2.5 text-left transition ${
                      selected
                        ? "bg-teal-50 ring-1 ring-teal-300"
                        : "bg-slate-50 hover:bg-teal-50/60"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white ${
                          selected ? "text-teal-700" : "text-slate-500"
                        }`}
                      >
                        <FileText size={14} />
                      </span>
                      <p className="min-w-0 flex-1 truncate text-[13px] font-semibold text-slate-900">
                        {bundle.title}
                      </p>
                      <span
                        className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em] ${
                          bundle.status === "SENT"
                            ? "bg-emerald-100 text-emerald-700"
                            : "bg-slate-200 text-slate-600"
                        }`}
                      >
                        {bundle.status}
                      </span>
                    </div>

                    <p className="mt-1.5 text-[12px] font-medium text-slate-500">
                      {monthLabel(bundle.month)} {bundle.year}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      Created {new Date(bundle.createdAt).toLocaleDateString()}
                    </p>

                    <div className="mt-1.5 flex items-center justify-end gap-2">
                      <span className="text-[11px] text-slate-400">Student list</span>
                      <span className="inline-flex items-center gap-0.5 rounded-md bg-teal-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                        View more
                        <ChevronRight size={11} />
                      </span>
                    </div>
                  </button>
                );
              })}
              {!isLoading && bundles.length === 0 ? (
                <div className="col-span-full rounded-lg border border-dashed border-slate-300 bg-slate-50 p-5 text-center">
                  <span className="mx-auto inline-flex h-11 w-11 items-center justify-center rounded-lg bg-white text-teal-700 shadow-sm">
                    <Files size={18} />
                  </span>
                  <p className="mt-3 text-sm font-semibold text-slate-800">No bundles found</p>
                  <p className="mt-1 text-sm leading-6 text-slate-500">Adjust the filters or create a new monthly bundle to get started.</p>
                </div>
              ) : null}
            </div>

            <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-slate-200 pt-2.5">
              <button
                type="button"
                onClick={() => void loadBundles(Math.max(1, page - 1))}
                disabled={page <= 1 || isLoading}
                className="btn-ghost h-8 gap-1.5 px-3 text-xs disabled:opacity-40"
              >
                <ChevronLeft size={14} />
                Prev
              </button>
              <p className="text-[12px] font-medium text-slate-500">
                {page} / {totalPages}
              </p>
              <button
                type="button"
                onClick={() => void loadBundles(Math.min(totalPages, page + 1))}
                disabled={page >= totalPages || isLoading}
                className="btn-ghost h-8 gap-1.5 px-3 text-xs disabled:opacity-40"
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>
          </section>
        </div>
      </div>

      {isRecipientPanelOpen && bundleDetail ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-black/10 bg-card p-4 shadow-2xl dark:border-white/10">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">Send Bundle</p>
                <h4 className="text-base font-semibold">
                  {bundleDetail.title}
                </h4>
                <p className="text-xs text-muted">
                  {bundleDetail.className} • {monthLabel(bundleDetail.month)} {bundleDetail.year}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsRecipientPanelOpen(false)}
                className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
              >
                Close
              </button>
            </div>

            <p className="mt-2 text-xs text-muted">
              Select students who should receive this month bundle. All students are pre-selected initially.
            </p>

            <div className="scrollbar-none mt-3 max-h-[320px] overflow-y-auto rounded-xl border border-black/10 p-3 dark:border-white/10">
              {bundleDetail.students.map((student) => (
                <label key={student.id} className="flex items-center gap-2 border-b border-black/5 py-1.5 last:border-b-0 dark:border-white/5">
                  <input
                    type="checkbox"
                    checked={recipientSelection[student.id] ?? false}
                    onChange={(e) =>
                      setRecipientSelection((prev) => ({
                        ...prev,
                        [student.id]: e.target.checked,
                      }))
                    }
                  />
                  <span className="text-sm">{student.name}</span>
                  {student.registrationNumber ? <span className="text-xs text-muted">({student.registrationNumber})</span> : null}
                </label>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between">
              <p className="text-xs text-muted">
                Selected: {Object.values(recipientSelection).filter(Boolean).length} / {bundleDetail.students.length}
              </p>
              <button
                type="button"
                onClick={() => void saveRecipientsAndSend()}
                disabled={isSaving}
                className="rounded-xl bg-foreground px-3 py-2 text-xs font-semibold text-background disabled:opacity-60"
              >
                Save recipients & mark as sent
              </button>
            </div>
          </div>
        </div>
      ) : null}


      {isHelpOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-3xl rounded-3xl border border-black/10 bg-card p-5 shadow-2xl dark:border-white/10 sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">About This Page</p>
                <h3 className="mt-2 text-xl font-semibold">Monthly Bundle Management</h3>
                <p className="mt-2 text-sm text-muted">
                  Manage tutes and papers by class, month, and year. Create monthly bundles, add tutes and papers as PDFs or descriptions, set paper time windows, and mark selected students as recipients when sending.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsHelpOpen(false)}
                className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
              >
                Close
              </button>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              <div className="rounded-2xl border border-black/10 bg-white/60 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <p className="text-sm font-semibold">What you can do here</p>
                <ul className="mt-2 space-y-2 text-sm text-muted">
                  <li>Create one bundle for a specific class, month, and year.</li>
                  <li>Add tutes or papers with PDF files, descriptions, or both.</li>
                  <li>Set start and end times for papers when they should be available.</li>
                  <li>Select which students should receive the bundle before sending.</li>
                </ul>
              </div>

              <div className="rounded-2xl border border-black/10 bg-white/60 p-4 dark:border-white/10 dark:bg-white/[0.03]">
                <p className="text-sm font-semibold">How the send flow works</p>
                <ul className="mt-2 space-y-2 text-sm text-muted">
                  <li>Choose recipients and mark the bundle as sent.</li>
                  <li>The teacher view shows exactly which students were selected.</li>
                  <li>Sent students remain in a waiting state until receipt is confirmed.</li>
                  <li>Confirmation status helps you track who has acknowledged the bundle.</li>
                </ul>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-900">
              <p className="font-semibold">Quick guide</p>
              <p className="mt-1">
                Start by creating the bundle, add the monthly tutes and papers, review the recipient list, and then use <span className="font-semibold">Save recipients & mark as sent</span> when the bundle is ready.
              </p>
            </div>
          </div>
        </div>
      ) : null}



      {isWizardOpen ? (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setIsWizardOpen(false)}
            aria-hidden
          />
          <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[520px] flex-col border-l border-slate-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Add class bundle</p>
                <h4 className="mt-1 truncate text-lg font-semibold text-slate-900">
                  {wizardStep === "details" ? "Bundle details" : wzTitle || "New bundle"}
                </h4>
                {wizardStep === "items" ? (
                  <p className="mt-0.5 truncate text-[12px] text-slate-500">
                    {classes.find((c) => c.id === wzClassId)?.name ?? "Class"} &bull; {wzMonthLabel}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setIsWizardOpen(false)}
                className="btn-secondary h-8 w-8 shrink-0 rounded-lg p-0"
                aria-label="Close add class bundle panel"
              >
                <X size={15} />
              </button>
            </div>

            <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">
              {wzError ? <p className="notice-error mb-3">{wzError}</p> : null}

              {wizardStep === "details" ? (
                <div className="space-y-4">
                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Class</span>
                    <div className="relative">
                      <GraduationCap size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      <select
                        value={wzClassId}
                        onChange={(e) => setWzClassId(e.target.value)}
                        className="control-select h-11 appearance-none pl-9 pr-9 text-sm"
                      >
                        <option value="">Select class</option>
                        {classes.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </label>

                  <label className="block space-y-1.5">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Title</span>
                    <input
                      value={wzTitle}
                      onChange={(e) => setWzTitle(e.target.value)}
                      placeholder="e.g. August tutes and papers"
                      maxLength={150}
                      className="control-input h-11 text-sm"
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="block space-y-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Year</span>
                      <div className="relative">
                        <Calendar size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <select
                          value={wzYear}
                          onChange={(e) => setWzYear(e.target.value)}
                          className="control-select h-11 appearance-none pl-9 pr-9 text-sm"
                        >
                          {yearOptions.map((y) => (
                            <option key={y} value={String(y)}>
                              {y}
                            </option>
                          ))}
                        </select>
                      </div>
                    </label>
                    <label className="block space-y-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Month</span>
                      <div className="relative">
                        <ChevronDown size={15} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                        <select
                          value={wzMonth}
                          onChange={(e) => setWzMonth(e.target.value)}
                          className="control-select h-11 appearance-none pr-9 text-sm"
                        >
                          {Array.from({ length: 12 }).map((_, idx) => (
                            <option key={idx + 1} value={String(idx + 1)}>
                              {monthLabel(idx + 1)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </label>
                  </div>

                  <p className="notice-info">
                    The bundle is created first. Then add tutes and papers, review the active
                    students, and submit to add them as recipients.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setWzError(null);
                        setWzPopover((prev) => (prev === "TUTE" ? null : "TUTE"));
                      }}
                      className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                        wzPopover === "TUTE"
                          ? "border-teal-600 bg-teal-600 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-teal-50"
                      }`}
                    >
                      <Plus size={14} />
                      Add tute
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setWzError(null);
                        setWzPopover((prev) => (prev === "PAPER" ? null : "PAPER"));
                      }}
                      className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                        wzPopover === "PAPER"
                          ? "border-teal-600 bg-teal-600 text-white"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-teal-50"
                      }`}
                    >
                      <Plus size={14} />
                      Add paper
                    </button>
                  </div>

                  {wzPopover ? (
                    <div className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        New {wzPopover === "TUTE" ? "tute" : "paper"}
                      </p>
                      <input
                        value={wzItemTitle}
                        onChange={(e) => setWzItemTitle(e.target.value)}
                        placeholder="Title"
                        maxLength={150}
                        className="control-input h-10 text-sm"
                      />
                      <textarea
                        value={wzItemDescription}
                        onChange={(e) => setWzItemDescription(e.target.value)}
                        rows={2}
                        placeholder="Description (optional)"
                        className="control-textarea text-sm"
                      />
                      <input
                        type="file"
                        accept="application/pdf"
                        onChange={(e) => setWzItemFile(e.target.files?.[0] ?? null)}
                        className="block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs file:mr-3 file:rounded-md file:border-0 file:bg-teal-50 file:px-2 file:py-1 file:font-semibold file:text-teal-700"
                      />
                      {wzPopover === "PAPER" ? (
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block space-y-1 text-[11px] font-medium text-slate-500">
                            Start time
                            <input
                              type="datetime-local"
                              value={wzPaperStart}
                              onChange={(e) => setWzPaperStart(e.target.value)}
                              className="control-input h-10 text-xs"
                            />
                          </label>
                          <label className="block space-y-1 text-[11px] font-medium text-slate-500">
                            End time
                            <input
                              type="datetime-local"
                              value={wzPaperEnd}
                              onChange={(e) => setWzPaperEnd(e.target.value)}
                              className="control-input h-10 text-xs"
                            />
                          </label>
                        </div>
                      ) : null}
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setWzPopover(null)}
                          className="btn-ghost h-8 px-3 text-xs"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void wizardAddItem()}
                          disabled={wzSaving}
                          className="btn-primary h-8 px-3 text-xs disabled:opacity-60"
                        >
                          {wzSaving ? "Adding..." : "Add"}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    {wzItems.length === 0 ? (
                      <p className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-center text-xs text-slate-500">
                        No tutes or papers added yet.
                      </p>
                    ) : (
                      wzItems.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-start justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
                                {item.type}
                              </span>
                              <p className="truncate text-[13px] font-semibold text-slate-900">
                                {item.title}
                              </p>
                            </div>
                            {item.type === "PAPER" && item.paperStartAt ? (
                              <p className="mt-0.5 text-[11px] text-slate-400">
                                {new Date(item.paperStartAt).toLocaleString()} -{" "}
                                {item.paperEndAt ? new Date(item.paperEndAt).toLocaleString() : "?"}
                              </p>
                            ) : null}
                            {item.fileName ? (
                              <p className="mt-0.5 truncate text-[11px] text-slate-400">{item.fileName}</p>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={() => void wizardRemoveItem(item.id)}
                            disabled={wzSaving}
                            className="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                            aria-label="Remove item"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))
                    )}
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white">
                    <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2">
                      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        <Users size={13} />
                        Active students
                      </div>
                      <span className="text-[11px] font-medium text-slate-400">
                        {wzSelectedCount}/{wzStudents.length}
                      </span>
                    </div>
                    <div className="scrollbar-thin max-h-[220px] overflow-y-auto p-1.5">
                      {wzLoadingStudents ? (
                        <p className="px-2 py-3 text-center text-xs text-slate-400">Loading students...</p>
                      ) : wzStudents.length === 0 ? (
                        <p className="px-2 py-3 text-center text-xs text-slate-400">
                          No active students for this month.
                        </p>
                      ) : (
                        wzStudents.map((s) => (
                          <label
                            key={s.id}
                            className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-50"
                          >
                            <input
                              type="checkbox"
                              checked={wzStudentSel[s.id] ?? false}
                              onChange={(e) =>
                                setWzStudentSel((prev) => ({ ...prev, [s.id]: e.target.checked }))
                              }
                            />
                            <span className="text-[13px] text-slate-700">{s.name}</span>
                            {s.registrationNumber ? (
                              <span className="text-[11px] text-slate-400">({s.registrationNumber})</span>
                            ) : null}
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 px-5 py-3">
              {wizardStep === "details" ? (
                <button
                  type="button"
                  onClick={() => void wizardCreateBundle()}
                  disabled={wzSaving}
                  className="btn-primary h-10 w-full disabled:opacity-60"
                >
                  {wzSaving ? "Creating..." : "Create bundle and add items"}
                </button>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsWizardOpen(false);
                      void loadBundles(1);
                    }}
                    className="btn-secondary h-10 flex-1"
                  >
                    Finish later
                  </button>
                  <button
                    type="button"
                    onClick={() => void wizardSubmit()}
                    disabled={wzSaving}
                    className="btn-primary h-10 flex-1 disabled:opacity-60"
                  >
                    {wzSaving
                      ? "Sending..."
                      : `Submit to ${wzSelectedCount} student${wzSelectedCount === 1 ? "" : "s"}`}
                  </button>
                </div>
              )}
            </div>
          </aside>
        </>
      ) : null}

    </div>
  );
}
