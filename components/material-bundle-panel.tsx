"use client";

import { useEffect, useMemo, useState } from "react";

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

type PaperSubmissionRecord = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  submittedAt: string;
  isLate: boolean;
};

type PaperSubmissionStudent = {
  id: string;
  name: string;
  registrationNumber: string | null;
  hasSubmitted: boolean;
  latestSubmittedAt: string | null;
  supportMessages: {
    id: string;
    message: string;
    createdAt: string;
  }[];
  submissions: PaperSubmissionRecord[];
};

type PaperSubmissionView = {
  item: {
    id: string;
    title: string;
    paperEndAt: string | null;
  };
  classroom: {
    id: string;
    name: string;
  };
  students: PaperSubmissionStudent[];
  summary: {
    totalStudents: number;
    submittedStudents: number;
    notSubmittedStudents: number;
  };
};

function readApiError(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object") return fallback;
  const typed = payload as ApiError;
  return typed.error?.message ?? typed.message ?? fallback;
}

function monthLabel(month: number) {
  return new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "long" });
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toDateTimeLocal(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}`;
}

export function MaterialBundlePanel() {
  const now = new Date();

  const [classes, setClasses] = useState<ClassItem[]>([]);
  const [bundles, setBundles] = useState<BundleListItem[]>([]);

  const [filterClassId, setFilterClassId] = useState("");
  const [filterYear, setFilterYear] = useState(String(now.getFullYear()));
  const [filterMonth, setFilterMonth] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [bundleDetail, setBundleDetail] = useState<BundleDetail | null>(null);

  const [createClassId, setCreateClassId] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createYear, setCreateYear] = useState(String(now.getFullYear()));
  const [createMonth, setCreateMonth] = useState(String(now.getMonth() + 1));

  const [itemType, setItemType] = useState<"TUTE" | "PAPER">("TUTE");
  const [itemTitle, setItemTitle] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [itemFile, setItemFile] = useState<File | null>(null);
  const [paperStartAt, setPaperStartAt] = useState("");
  const [paperEndAt, setPaperEndAt] = useState("");

  const [editItemId, setEditItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editPaperStartAt, setEditPaperStartAt] = useState("");
  const [editPaperEndAt, setEditPaperEndAt] = useState("");

  const [recipientSelection, setRecipientSelection] = useState<Record<string, boolean>>({});
  const [isRecipientPanelOpen, setIsRecipientPanelOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [isCreatePanelOpen, setIsCreatePanelOpen] = useState(false);
  const [isItemPanelOpen, setIsItemPanelOpen] = useState(false);
  const [confirmAddToSentBundle, setConfirmAddToSentBundle] = useState(false);
  const [activeItemTab, setActiveItemTab] = useState<"TUTE" | "PAPER">("TUTE");
  const [isSubmissionsOpen, setIsSubmissionsOpen] = useState(false);
  const [isLoadingSubmissions, setIsLoadingSubmissions] = useState(false);
  const [submissionsView, setSubmissionsView] = useState<PaperSubmissionView | null>(null);
  const [submissionsItemId, setSubmissionsItemId] = useState<string | null>(null);

  const [previewItem, setPreviewItem] = useState<BundleItem | null>(null);
  const [isPreviewFullScreen, setIsPreviewFullScreen] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
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

      const classList = payload.data ?? [];
      setClasses(classList);
      if (!createClassId && classList[0]) {
        setCreateClassId(classList[0].id);
      }
    }

    void loadClasses().catch((error) => {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load classes.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadBundles(nextPage = page) {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const qs = new URLSearchParams({
        page: String(nextPage),
        pageSize: "8",
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

  async function handleCreateBundle() {
    if (!createClassId) {
      setErrorMessage("Class is required.");
      return;
    }
    if (!createTitle.trim()) {
      setErrorMessage("Bundle title is required.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/material-bundles", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          classId: createClassId,
          title: createTitle.trim(),
          year: Number(createYear),
          month: Number(createMonth),
        }),
      });

      const payload = (await response.json()) as {
        success: boolean;
        data?: { bundle: { id: string } };
      };

      if (!response.ok || !payload.success || !payload.data?.bundle?.id) {
        throw new Error(readApiError(payload, "Failed to create bundle."));
      }

      await loadBundles(1);
      await loadBundleDetails(payload.data.bundle.id);
      setSuccessMessage("Bundle created successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to create bundle.");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleAddItem() {
    if (!selectedBundleId) {
      setErrorMessage("Select a bundle first.");
      return;
    }

    if (bundleDetail?.status === "SENT" && !confirmAddToSentBundle) {
      setErrorMessage("This bundle is already sent. Confirm before adding a new item.");
      return;
    }

    if (!itemTitle.trim()) {
      setErrorMessage("Item title is required.");
      return;
    }

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const formData = new FormData();
      formData.set("type", itemType);
      formData.set("title", itemTitle.trim());
      if (itemDescription.trim()) formData.set("description", itemDescription.trim());
      if (itemType === "PAPER") {
        formData.set("paperStartAt", paperStartAt);
        formData.set("paperEndAt", paperEndAt);
      }
      if (itemFile) formData.set("file", itemFile);

      const response = await fetch(`/api/material-bundles/${selectedBundleId}/items`, {
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

      const newItem = payload.data.item;

      setItemTitle("");
      setItemDescription("");
      setItemFile(null);
      setPaperStartAt("");
      setPaperEndAt("");
      setConfirmAddToSentBundle(false);
      setIsItemPanelOpen(false);

      setBundleDetail((prev) =>
        prev ? { ...prev, items: [...prev.items, newItem] } : prev
      );
      setBundles((prev) =>
        prev.map((b) =>
          b.id === selectedBundleId
            ? { ...b, _count: { ...b._count, items: b._count.items + 1 } }
            : b
        )
      );
      setSuccessMessage("Item added successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to add item.");
    } finally {
      setIsSaving(false);
    }
  }

  function openAddItemPanel() {
    if (!selectedBundleId || !bundleDetail) {
      setErrorMessage("Select a bundle first.");
      return;
    }

    setConfirmAddToSentBundle(false);
    setIsItemPanelOpen(true);
  }

  async function handleDeleteItem(itemId: string) {
    if (!selectedBundleId) return;

    const confirmed = window.confirm("Delete this item?");
    if (!confirmed) return;

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/material-bundles/${selectedBundleId}/items/${itemId}`, {
        method: "DELETE",
      });
      const payload = (await response.json()) as { success: boolean };

      if (!response.ok || !payload.success) {
        throw new Error(readApiError(payload, "Failed to delete item."));
      }

      setBundleDetail((prev) =>
        prev ? { ...prev, items: prev.items.filter((i) => i.id !== itemId) } : prev
      );
      setBundles((prev) =>
        prev.map((b) =>
          b.id === selectedBundleId
            ? { ...b, _count: { ...b._count, items: Math.max(0, b._count.items - 1) } }
            : b
        )
      );
      setSuccessMessage("Item deleted successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to delete item.");
    } finally {
      setIsSaving(false);
    }
  }

  async function openSubmissions(item: BundleItem) {
    if (!selectedBundleId) return;

    setIsSubmissionsOpen(true);
    setIsLoadingSubmissions(true);
    setSubmissionsItemId(item.id);
    setSubmissionsView(null);
    setErrorMessage(null);

    try {
      const response = await fetch(
        `/api/material-bundles/${selectedBundleId}/items/${item.id}/submissions`,
        { cache: "no-store" }
      );
      const payload = (await response.json()) as {
        success: boolean;
        data?: PaperSubmissionView;
      };

      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(readApiError(payload, "Failed to load submissions."));
      }

      setSubmissionsView(payload.data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to load submissions.");
    } finally {
      setIsLoadingSubmissions(false);
    }
  }

  function beginEditItem(item: BundleItem) {
    setActiveItemTab(item.type);
    setEditItemId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description ?? "");
    setEditPaperStartAt(toDateTimeLocal(item.paperStartAt));
    setEditPaperEndAt(toDateTimeLocal(item.paperEndAt));
  }

  async function handleSaveItemEdit(itemType: "TUTE" | "PAPER") {
    if (!selectedBundleId || !editItemId) return;

    setIsSaving(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      const payload: {
        title: string;
        description?: string;
        paperStartAt?: string | null;
        paperEndAt?: string | null;
      } = {
        title: editTitle.trim(),
      };

      if (editDescription.trim()) payload.description = editDescription.trim();
      if (itemType === "PAPER") {
        payload.paperStartAt = editPaperStartAt ? new Date(editPaperStartAt).toISOString() : null;
        payload.paperEndAt = editPaperEndAt ? new Date(editPaperEndAt).toISOString() : null;
      }

      const response = await fetch(`/api/material-bundles/${selectedBundleId}/items/${editItemId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const resultPayload = (await response.json()) as {
        success: boolean;
        data?: { item: BundleItem };
      };
      if (!response.ok || !resultPayload.success || !resultPayload.data?.item) {
        throw new Error(readApiError(resultPayload, "Failed to update item."));
      }

      const updatedItem = resultPayload.data.item;
      setEditItemId(null);
      setBundleDetail((prev) =>
        prev
          ? { ...prev, items: prev.items.map((i) => (i.id === updatedItem.id ? updatedItem : i)) }
          : prev
      );
      setSuccessMessage("Item updated successfully.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to update item.");
    } finally {
      setIsSaving(false);
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

  const tuteItems = useMemo(
    () => (bundleDetail?.items ?? []).filter((item) => item.type === "TUTE"),
    [bundleDetail?.items]
  );
  const paperItems = useMemo(
    () => (bundleDetail?.items ?? []).filter((item) => item.type === "PAPER"),
    [bundleDetail?.items]
  );

  return (
    <div className="rounded-3xl border border-black/10 bg-card p-6 shadow-sm dark:border-white/10 sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Monthly Tutes & Papers</p>
          <h2 className="mt-2 text-xl font-semibold">Create and send class bundles</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Manage monthly tutes and papers by class, year, and month, then send each bundle to selected students.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setIsCreatePanelOpen(true)}
            className="rounded-xl bg-foreground px-4 py-2 text-sm font-semibold text-background hover:opacity-90"
          >
            Add bundle
          </button>
          <button
            type="button"
            onClick={() => setIsHelpOpen(true)}
            className="rounded-xl border border-black/10 px-3 py-2 text-sm font-semibold hover:bg-black/[0.03] dark:border-white/15 dark:hover:bg-white/[0.05]"
          >
            Help
          </button>
        </div>
      </div>

      {errorMessage ? (
        <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{errorMessage}</p>
      ) : null}
      {successMessage ? (
        <p className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {successMessage}
        </p>
      ) : null}

      <div className="mt-6 grid gap-4 xl:grid-cols-[320px_1fr]">
        <aside className="rounded-2xl border border-black/10 p-4 dark:border-white/10">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Filters</p>
          <div className="mt-3 space-y-2">
            <select
              value={filterClassId}
              onChange={(e) => setFilterClassId(e.target.value)}
              className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
            >
              <option value="">All classes</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                value={filterYear}
                onChange={(e) => setFilterYear(e.target.value)}
                placeholder="Year"
                className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
              />
              <select
                value={filterMonth}
                onChange={(e) => setFilterMonth(e.target.value)}
                className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
              >
                <option value="">Month</option>
                {Array.from({ length: 12 }).map((_, idx) => (
                  <option key={idx + 1} value={String(idx + 1)}>
                    {monthLabel(idx + 1)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Bundles</p>
          {isLoading ? <p className="mt-2 text-xs text-muted">Loading...</p> : null}
          <div className="mt-3 space-y-2">
            {bundles.map((bundle) => (
              <button
                key={bundle.id}
                type="button"
                onClick={() => void loadBundleDetails(bundle.id)}
                className={`w-full rounded-xl border px-3 py-2 text-left ${
                  selectedBundleId === bundle.id
                    ? "border-brand-500 bg-brand-50"
                    : "border-black/10 hover:bg-black/[0.02] dark:border-white/10 dark:hover:bg-white/[0.04]"
                }`}
              >
                <p className="text-sm font-semibold">{bundle.title}</p>
                <p className="text-xs text-muted">
                  {bundle.class.name} • {monthLabel(bundle.month)} {bundle.year}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {bundle._count.items} items • {bundle.status === "SENT" ? "Sent" : "Draft"}
                </p>
                <p className="text-xs text-muted">
                  Created {new Date(bundle.createdAt).toLocaleDateString()}
                </p>
              </button>
            ))}
            {!isLoading && bundles.length === 0 ? (
              <p className="rounded-xl border border-dashed border-black/15 p-3 text-xs text-muted dark:border-white/15">
                No bundles found.
              </p>
            ) : null}
          </div>

          <div className="mt-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => void loadBundles(Math.max(1, page - 1))}
              disabled={page <= 1 || isLoading}
              className="rounded-lg border border-black/10 px-2.5 py-1 text-xs disabled:opacity-40 dark:border-white/15"
            >
              Prev
            </button>
            <p className="text-xs text-muted">
              {page} / {totalPages}
            </p>
            <button
              type="button"
              onClick={() => void loadBundles(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages || isLoading}
              className="rounded-lg border border-black/10 px-2.5 py-1 text-xs disabled:opacity-40 dark:border-white/15"
            >
              Next
            </button>
          </div>
        </aside>

        <section className="rounded-2xl border border-black/10 p-4 dark:border-white/10">
          {!bundleDetail || isLoadingDetails ? (
            <p className="text-sm text-muted">{isLoadingDetails ? "Loading bundle details..." : "Select a bundle to manage items and recipients."}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted">Bundle Details</p>
                  <h3 className="mt-1 text-lg font-semibold">
                    {bundleDetail.title}
                  </h3>
                  <p className="text-xs text-muted">
                    {bundleDetail.className} • {monthLabel(bundleDetail.month)} {bundleDetail.year}
                  </p>
                  <p className="text-xs text-muted">
                    Status: {bundleDetail.status}
                    {bundleDetail.sentAt ? ` • Sent ${new Date(bundleDetail.sentAt).toLocaleString()}` : ""}
                  </p>
                  <p className="text-xs text-muted">
                    Created {new Date(bundleDetail.createdAt).toLocaleString()}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={openRecipientPanel}
                  className="rounded-xl bg-foreground px-3 py-2 text-xs font-semibold text-background"
                >
                  Set recipients & send
                </button>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-black/10 px-3 py-2 dark:border-white/10">
                  <p className="text-xs text-muted">Class students</p>
                  <p className="text-lg font-semibold">{bundleDetail.summary.totalStudents}</p>
                </div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <p className="text-xs text-emerald-700">Will receive</p>
                  <p className="text-lg font-semibold text-emerald-700">{bundleDetail.summary.willReceiveCount}</p>
                </div>
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                  <p className="text-xs text-amber-700">Will not receive</p>
                  <p className="text-lg font-semibold text-amber-700">{bundleDetail.summary.willNotReceiveCount}</p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-black/10 p-3 dark:border-white/10">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">Add tute / paper</p>
                    <p className="mt-1 text-xs text-muted">Open the side panel to add new items to this bundle.</p>
                  </div>
                  <button
                    type="button"
                    onClick={openAddItemPanel}
                    className="rounded-xl border border-black/10 px-3 py-2 text-xs font-semibold dark:border-white/15"
                  >
                    Add tute / paper
                  </button>
                </div>
              </div>

              <div className="mt-5 rounded-xl border border-black/10 dark:border-white/10">
                <div className="flex items-center gap-2 border-b border-black/10 p-2 dark:border-white/10">
                  <button
                    type="button"
                    onClick={() => setActiveItemTab("TUTE")}
                    className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                      activeItemTab === "TUTE"
                        ? "bg-foreground text-background"
                        : "border border-black/10 text-muted hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.05]"
                    }`}
                  >
                    Tutes ({tuteItems.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveItemTab("PAPER")}
                    className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                      activeItemTab === "PAPER"
                        ? "bg-foreground text-background"
                        : "border border-black/10 text-muted hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/[0.05]"
                    }`}
                  >
                    Papers ({paperItems.length})
                  </button>
                </div>

                <div className="p-3">
                  {activeItemTab === "TUTE" ? (
                    <div className="space-y-2">
                      {tuteItems.map((item) => (
                        <div key={item.id} className="rounded-lg border border-black/10 p-2 dark:border-white/10">
                          {editItemId === item.id ? (
                            <>
                              <input
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                className="w-full rounded-lg border border-black/10 px-2 py-1 text-sm dark:border-white/10"
                              />
                              <textarea
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                                rows={2}
                                className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1 text-sm dark:border-white/10"
                              />
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleSaveItemEdit(item.type)}
                                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditItemId(null)}
                                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <p className="text-sm font-semibold">{item.title}</p>
                              {item.description ? <p className="text-xs text-muted">{item.description}</p> : null}
                              <p className="text-xs text-muted">Created {new Date(item.createdAt).toLocaleString()}</p>
                              <p className="text-xs text-muted">File: {item.fileName ?? "No file"} ({formatBytes(item.sizeBytes)})</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => beginEditItem(item)}
                                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                >
                                  Edit
                                </button>
                                {item.fileUrl ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setPreviewItem(item)}
                                      className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                    >
                                      Preview
                                    </button>
                                    <a
                                      href={`/api/material-bundles/${bundleDetail.id}/items/${item.id}/file?download=1`}
                                      className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                    >
                                      Download
                                    </a>
                                  </>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteItem(item.id)}
                                  className="rounded-lg border border-red-300 px-2.5 py-1 text-xs text-red-700"
                                >
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      {tuteItems.length === 0 ? <p className="text-xs text-muted">No tutes added yet.</p> : null}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {paperItems.map((item) => (
                        <div key={item.id} className="rounded-lg border border-black/10 p-2 dark:border-white/10">
                          {editItemId === item.id ? (
                            <>
                              <input
                                value={editTitle}
                                onChange={(e) => setEditTitle(e.target.value)}
                                className="w-full rounded-lg border border-black/10 px-2 py-1 text-sm dark:border-white/10"
                              />
                              <textarea
                                value={editDescription}
                                onChange={(e) => setEditDescription(e.target.value)}
                                rows={2}
                                className="mt-1 w-full rounded-lg border border-black/10 px-2 py-1 text-sm dark:border-white/10"
                              />
                              <div className="mt-1 grid gap-1 sm:grid-cols-2">
                                <input
                                  type="datetime-local"
                                  value={editPaperStartAt}
                                  onChange={(e) => setEditPaperStartAt(e.target.value)}
                                  className="rounded-lg border border-black/10 px-2 py-1 text-sm dark:border-white/10"
                                />
                                <input
                                  type="datetime-local"
                                  value={editPaperEndAt}
                                  onChange={(e) => setEditPaperEndAt(e.target.value)}
                                  className="rounded-lg border border-black/10 px-2 py-1 text-sm dark:border-white/10"
                                />
                              </div>
                              <div className="mt-2 flex gap-2">
                                <button
                                  type="button"
                                  onClick={() => void handleSaveItemEdit(item.type)}
                                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditItemId(null)}
                                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                >
                                  Cancel
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              <p className="text-sm font-semibold">{item.title}</p>
                              {item.description ? <p className="text-xs text-muted">{item.description}</p> : null}
                              <p className="text-xs text-muted">Created {new Date(item.createdAt).toLocaleString()}</p>
                              <p className="text-xs text-muted">
                                Window: {item.paperStartAt ? new Date(item.paperStartAt).toLocaleString() : "-"} -{" "}
                                {item.paperEndAt ? new Date(item.paperEndAt).toLocaleString() : "-"}
                              </p>
                              <p className="text-xs text-muted">File: {item.fileName ?? "No file"} ({formatBytes(item.sizeBytes)})</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => beginEditItem(item)}
                                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void openSubmissions(item)}
                                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                >
                                  Submissions
                                </button>
                                {item.fileUrl ? (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setPreviewItem(item)}
                                      className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                    >
                                      Preview
                                    </button>
                                    <a
                                      href={`/api/material-bundles/${bundleDetail.id}/items/${item.id}/file?download=1`}
                                      className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/10"
                                    >
                                      Download
                                    </a>
                                  </>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteItem(item.id)}
                                  className="rounded-lg border border-red-300 px-2.5 py-1 text-xs text-red-700"
                                >
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                      {paperItems.length === 0 ? <p className="text-xs text-muted">No papers added yet.</p> : null}
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                  <p className="text-sm font-semibold text-emerald-700">
                    {bundleDetail.status === "SENT" ? "Students this bundle was sent to" : "Students who will receive"}
                  </p>
                  <div className="mt-2 space-y-1">
                    {bundleDetail.students
                      .filter((s) => s.willReceive)
                      .map((student) => (
                        <div key={student.id} className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200/70 bg-white/60 px-2 py-1.5 text-xs text-emerald-700">
                          <span>
                            {student.name}
                            {student.registrationNumber ? ` (${student.registrationNumber})` : ""}
                          </span>
                          <span className={`rounded-full px-2 py-0.5 font-semibold ${student.receivedAt ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>
                            {student.receivedAt ? `Confirmed ${new Date(student.receivedAt).toLocaleString()}` : "Waiting for confirmation"}
                          </span>
                        </div>
                      ))}
                    {bundleDetail.students.filter((s) => s.willReceive).length === 0 ? (
                      <p className="text-xs text-emerald-700/80">No students selected.</p>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-semibold text-amber-700">Students who will not receive</p>
                  <div className="mt-2 space-y-1">
                    {bundleDetail.students
                      .filter((s) => !s.willReceive)
                      .map((student) => (
                        <p key={student.id} className="text-xs text-amber-700">
                          {student.name}
                          {student.registrationNumber ? ` (${student.registrationNumber})` : ""}
                        </p>
                      ))}
                    {bundleDetail.students.filter((s) => !s.willReceive).length === 0 ? (
                      <p className="text-xs text-amber-700/80">All students are selected.</p>
                    ) : null}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
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

            <div className="mt-3 max-h-[320px] overflow-y-auto rounded-xl border border-black/10 p-3 dark:border-white/10">
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

      {/* Submissions side panel backdrop (mobile only) */}
      {isSubmissionsOpen && selectedBundleId ? (
        <div
          className="fixed inset-0 z-40 bg-black/40 lg:hidden"
          onClick={() => { setIsSubmissionsOpen(false); setSubmissionsItemId(null); }}
        />
      ) : null}

      {/* Submissions side panel */}
      <div
        className={`fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-card shadow-2xl transition-transform duration-300 lg:w-1/2 ${
          isSubmissionsOpen && selectedBundleId ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-start justify-between gap-3 border-b border-black/10 px-4 py-3 dark:border-white/10">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Paper Submissions</p>
            <h4 className="text-base font-semibold">
              {submissionsView?.item.title ?? (isLoadingSubmissions ? "Loading…" : "")}
            </h4>
            <p className="text-xs text-muted">{submissionsView?.classroom.name ?? ""}</p>
            {submissionsView?.item.paperEndAt ? (
              <p className="text-xs text-muted">
                Deadline: {new Date(submissionsView.item.paperEndAt).toLocaleString()}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => { setIsSubmissionsOpen(false); setSubmissionsItemId(null); }}
            className="mt-0.5 shrink-0 rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
          >
            Close
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {isLoadingSubmissions ? (
            <p className="text-sm text-muted">Loading submissions…</p>
          ) : null}

          {submissionsView ? (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-xl border border-black/10 px-3 py-2 dark:border-white/10">
                  <p className="text-xs text-muted">Total students</p>
                  <p className="text-lg font-semibold">{submissionsView.summary.totalStudents}</p>
                </div>
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
                  <p className="text-xs text-emerald-700">Submitted</p>
                  <p className="text-lg font-semibold text-emerald-700">{submissionsView.summary.submittedStudents}</p>
                </div>
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                  <p className="text-xs text-amber-700">Not submitted</p>
                  <p className="text-lg font-semibold text-amber-700">{submissionsView.summary.notSubmittedStudents}</p>
                </div>
              </div>

              <div className="mt-4 space-y-3">
                {submissionsView.students.map((student) => (
                  <div key={student.id} className="rounded-xl border border-black/10 p-3 dark:border-white/10">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-semibold">
                        {student.name}
                        {student.registrationNumber ? ` (${student.registrationNumber})` : ""}
                      </p>
                      {student.hasSubmitted ? (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          Submitted
                        </span>
                      ) : (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">
                          Not submitted
                        </span>
                      )}
                    </div>

                    {student.hasSubmitted ? (
                      <>
                        <p className="mt-1 text-xs text-muted">
                          Latest: {student.latestSubmittedAt ? new Date(student.latestSubmittedAt).toLocaleString() : "-"}
                        </p>
                        <div className="mt-2 space-y-2">
                          {student.submissions.map((submission) => (
                            <div key={submission.id} className="rounded-lg border border-black/10 px-2.5 py-2 text-xs dark:border-white/10">
                              <p className="font-semibold">{submission.fileName}</p>
                              <p className="text-muted">
                                Submitted {new Date(submission.submittedAt).toLocaleString()} • {formatBytes(submission.sizeBytes)}
                              </p>
                              <p className={submission.isLate ? "text-red-700" : "text-emerald-700"}>
                                {submission.isLate ? "Late submission" : "On-time submission"}
                              </p>
                              <div className="mt-1 flex gap-2">
                                <a
                                  href={`/api/material-bundles/${selectedBundleId}/items/${submissionsItemId ?? submissionsView.item.id}/submissions/${submission.id}/file`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="rounded-lg border border-black/10 px-2 py-1 dark:border-white/10"
                                >
                                  Preview
                                </a>
                                <a
                                  href={`/api/material-bundles/${selectedBundleId}/items/${submissionsItemId ?? submissionsView.item.id}/submissions/${submission.id}/file?download=1`}
                                  className="rounded-lg border border-black/10 px-2 py-1 dark:border-white/10"
                                >
                                  Download
                                </a>
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : null}

                    {student.supportMessages.length > 0 ? (
                      <div className="mt-2 space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-2">
                        <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Student late reasons</p>
                        {student.supportMessages.map((msg) => (
                          <div key={msg.id} className="rounded-md border border-amber-200 bg-white px-2 py-1.5 text-xs">
                            <p className="text-slate-700 whitespace-pre-line">{msg.message}</p>
                            <p className="mt-1 text-[11px] text-slate-500">{new Date(msg.createdAt).toLocaleString()}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      </div>

      {previewItem && selectedBundleId ? (
        <div className="fixed inset-0 z-[60] bg-black/80 p-4">
          <div className="mx-auto flex h-full w-full max-w-6xl flex-col rounded-2xl bg-card">
            <div className="flex items-center justify-between border-b border-black/10 px-4 py-2 dark:border-white/10">
              <p className="truncate text-sm font-semibold">{previewItem.title}</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setIsPreviewFullScreen((prev) => !prev)}
                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
                >
                  {isPreviewFullScreen ? "Exit full screen" : "Full screen"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPreviewItem(null);
                    setIsPreviewFullScreen(false);
                  }}
                  className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
                >
                  Close
                </button>
              </div>
            </div>

            <iframe
              src={`/api/material-bundles/${selectedBundleId}/items/${previewItem.id}/file`}
              title={previewItem.title}
              className={`w-full flex-1 border-0 ${isPreviewFullScreen ? "h-screen" : "h-[75vh]"}`}
            />
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

      {isCreatePanelOpen && (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-black/10 bg-card shadow-xl dark:border-white/10">
          <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-black/10 bg-card p-4 dark:border-white/10">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Create New Bundle</p>
              <h4 className="mt-1 text-lg font-semibold">Monthly bundle details</h4>
            </div>
            <button
              type="button"
              onClick={() => setIsCreatePanelOpen(false)}
              className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
            >
              Close
            </button>
          </div>

          <div className="space-y-3 p-4 pt-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Class</label>
              <select
                value={createClassId}
                onChange={(e) => setCreateClassId(e.target.value)}
                className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
              >
                <option value="">Select class</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-sm font-medium">Bundle title</label>
              <input
                type="text"
                placeholder="e.g. Monthly Tutes"
                value={createTitle}
                onChange={(e) => setCreateTitle(e.target.value)}
                className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-sm font-medium">Year</label>
                <input
                  type="number"
                  value={createYear}
                  onChange={(e) => setCreateYear(e.target.value)}
                  className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Month</label>
                <select
                  value={createMonth}
                  onChange={(e) => setCreateMonth(e.target.value)}
                  className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
                >
                  {Array.from({ length: 12 }).map((_, idx) => (
                    <option key={idx + 1} value={String(idx + 1)}>
                      {monthLabel(idx + 1)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsCreatePanelOpen(false)}
                className="flex-1 rounded-xl border border-black/10 px-4 py-2 text-sm font-semibold hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleCreateBundle();
                  setIsCreatePanelOpen(false);
                }}
                disabled={isSaving}
                className="flex-1 rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60"
              >
                {isSaving ? "Creating..." : "Create bundle"}
              </button>
            </div>
          </div>
        </div>
      )}

      {isItemPanelOpen && bundleDetail && selectedBundleId ? (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md overflow-y-auto border-l border-black/10 bg-card shadow-xl dark:border-white/10">
          <div className="sticky top-0 flex items-center justify-between gap-2 border-b border-black/10 bg-card p-4 dark:border-white/10">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Add Item</p>
              <h4 className="mt-1 text-lg font-semibold">Add tute / paper</h4>
              <p className="text-xs text-muted">
                {bundleDetail.title} • {monthLabel(bundleDetail.month)} {bundleDetail.year}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsItemPanelOpen(false)}
              className="rounded-lg border border-black/10 px-2.5 py-1 text-xs dark:border-white/15"
            >
              Close
            </button>
          </div>

          <div className="space-y-3 p-4 pt-3">
            {bundleDetail.status === "SENT" ? (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                <p className="font-semibold">Warning: bundle already sent</p>
                <p className="mt-1">
                  This bundle was already sent
                  {bundleDetail.sentAt ? ` on ${new Date(bundleDetail.sentAt).toLocaleString()}` : ""}. Adding new items now will not automatically re-send to students.
                </p>
                <label className="mt-3 flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={confirmAddToSentBundle}
                    onChange={(e) => setConfirmAddToSentBundle(e.target.checked)}
                  />
                  <span>I understand and confirm adding an item to an already sent bundle.</span>
                </label>
              </div>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-2">
              <select
                value={itemType}
                onChange={(e) => setItemType(e.target.value as "TUTE" | "PAPER")}
                className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
              >
                <option value="TUTE">Tute</option>
                <option value="PAPER">Paper</option>
              </select>
              <input
                value={itemTitle}
                onChange={(e) => setItemTitle(e.target.value)}
                placeholder="Title"
                className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
              />
            </div>

            <textarea
              value={itemDescription}
              onChange={(e) => setItemDescription(e.target.value)}
              rows={3}
              placeholder="Description (optional)"
              className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
            />

            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setItemFile(e.target.files?.[0] ?? null)}
              className="block w-full rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
            />

            {itemType === "PAPER" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="datetime-local"
                  value={paperStartAt}
                  onChange={(e) => setPaperStartAt(e.target.value)}
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
                />
                <input
                  type="datetime-local"
                  value={paperEndAt}
                  onChange={(e) => setPaperEndAt(e.target.value)}
                  className="rounded-xl border border-black/10 bg-white px-3 py-2 text-sm dark:border-white/15 dark:bg-transparent"
                />
              </div>
            ) : null}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setIsItemPanelOpen(false)}
                className="flex-1 rounded-xl border border-black/10 px-4 py-2 text-sm font-semibold hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/5"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleAddItem()}
                disabled={isSaving || (bundleDetail.status === "SENT" && !confirmAddToSentBundle)}
                className="flex-1 rounded-xl bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-60"
              >
                {isSaving ? "Adding..." : "Add item"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
