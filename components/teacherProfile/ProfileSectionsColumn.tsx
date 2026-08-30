"use client";

import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical } from "lucide-react";

export type ProfileSectionType =
  | "ABOUT_ME"
  | "ANNOUNCEMENTS"
  | "SUBJECTS"
  | "SOCIAL_MEDIA"
  | "QUALIFICATIONS"
  | "ACHIEVEMENTS";

const DEFAULT_ORDER: ProfileSectionType[] = [
  "ABOUT_ME",
  "ANNOUNCEMENTS",
  "SUBJECTS",
  "SOCIAL_MEDIA",
  "QUALIFICATIONS",
  "ACHIEVEMENTS",
];

interface Props {
  teacherId: string;
  isPublic?: boolean;
  /** Order resolved on the server; avoids a reordering flash on first paint. */
  initialOrder?: ProfileSectionType[];
  /** The rendered card for each section that should appear in this column. */
  sections: Partial<Record<ProfileSectionType, ReactNode>>;
}

interface ApiResponse {
  success?: boolean;
  data?: { sectionType: ProfileSectionType; displayOrder: number }[];
}

function normalizeOrder(order: ProfileSectionType[]): ProfileSectionType[] {
  const seen = new Set<ProfileSectionType>();
  const result: ProfileSectionType[] = [];

  for (const type of order) {
    if (DEFAULT_ORDER.includes(type) && !seen.has(type)) {
      seen.add(type);
      result.push(type);
    }
  }

  // Append any section missing from the provided order.
  for (const type of DEFAULT_ORDER) {
    if (!seen.has(type)) {
      result.push(type);
    }
  }

  return result;
}

export default function ProfileSectionsColumn({
  teacherId,
  isPublic,
  initialOrder,
  sections,
}: Props) {
  const [order, setOrder] = useState<ProfileSectionType[]>(
    normalizeOrder(initialOrder ?? DEFAULT_ORDER)
  );

  // Which item is currently allowed to start an HTML5 drag (grabbed by handle).
  const [grabbedType, setGrabbedType] = useState<ProfileSectionType | null>(
    null
  );
  const [draggingType, setDraggingType] = useState<ProfileSectionType | null>(
    null
  );
  const [overType, setOverType] = useState<ProfileSectionType | null>(null);
  const [saving, setSaving] = useState(false);

  const lastSavedOrder = useRef<string>(order.join(","));

  // Fetch the saved order when the server did not provide one.
  useEffect(() => {
    if (initialOrder || !teacherId) return;

    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(
          `/api/public/teacher/profile-sections?teacherId=${teacherId}`,
          { cache: "no-store" }
        );
        const payload = (await response.json()) as ApiResponse;

        if (cancelled || !payload.data) return;

        const fetched = payload.data
          .slice()
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map((row) => row.sectionType);

        const next = normalizeOrder(fetched);
        setOrder(next);
        lastSavedOrder.current = next.join(",");
      } catch {
        // Keep the default order on failure.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [teacherId, initialOrder]);

  async function persistOrder(next: ProfileSectionType[]) {
    if (next.join(",") === lastSavedOrder.current) return;

    setSaving(true);
    try {
      const response = await fetch("/api/teacher/profile/sections", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: next }),
      });

      if (!response.ok) {
        throw new Error("Failed to save section order.");
      }

      lastSavedOrder.current = next.join(",");
    } catch (error) {
      // Roll back to the last known-good order.
      const reverted = normalizeOrder(lastSavedOrder.current.split(",") as ProfileSectionType[]);
      setOrder(reverted);
      alert(
        error instanceof Error
          ? error.message
          : "Failed to save section order."
      );
    } finally {
      setSaving(false);
    }
  }

  function moveSection(from: ProfileSectionType, to: ProfileSectionType) {
    if (from === to) return;

    setOrder((current) => {
      const next = current.filter((type) => type !== from);
      const toIndex = next.indexOf(to);
      next.splice(toIndex, 0, from);
      return next;
    });
  }

  function handleDrop() {
    setOverType(null);
    setDraggingType(null);
    setGrabbedType(null);

    setOrder((current) => {
      void persistOrder(current);
      return current;
    });
  }

  const renderList = useMemo(
    () => order.filter((type) => sections[type] !== undefined),
    [order, sections]
  );

  return (
    <div className="space-y-6">
      {renderList.map((type) => {
        const isDragging = draggingType === type;
        const isOver = overType === type && draggingType !== type;

        return (
          <div
            key={type}
            draggable={!isPublic && grabbedType === type}
            onDragStart={(event) => {
              setDraggingType(type);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnter={() => {
              if (draggingType && draggingType !== type) {
                setOverType(type);
                moveSection(draggingType, type);
              }
            }}
            onDragOver={(event) => {
              if (draggingType) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              handleDrop();
            }}
            onDragEnd={handleDrop}
            className={`relative rounded-xl transition empty:hidden ${
              isDragging ? "opacity-50" : ""
            } ${isOver ? "ring-2 ring-emerald-400 ring-offset-2" : ""}`}
          >
            {!isPublic && (
              <button
                type="button"
                aria-label="Drag to reorder section"
                title="Drag to reorder"
                onMouseDown={() => setGrabbedType(type)}
                onMouseUp={() => setGrabbedType(null)}
                onTouchStart={() => setGrabbedType(type)}
                onTouchEnd={() => setGrabbedType(null)}
                className="absolute -left-3 top-4 z-10 hidden cursor-grab items-center rounded-md border border-slate-200 bg-white p-1 text-slate-400 shadow-sm transition hover:text-slate-600 active:cursor-grabbing lg:flex"
              >
                <GripVertical className="h-4 w-4" />
              </button>
            )}

            {sections[type]}
          </div>
        );
      })}

      {!isPublic && saving && (
        <p className="text-right text-[12px] text-slate-400">Saving order…</p>
      )}
    </div>
  );
}
