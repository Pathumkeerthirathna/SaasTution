"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";

// DOM id for a row that a `?focus=<id>` deep link can target.
export function focusElementId(id: string) {
  return `focus-${id}`;
}

const RING_CLASSES = ["ring-2", "ring-emerald-400", "ring-offset-2"];

// When the page is opened with `?focus=<id>`, scroll the matching row
// (`id={focusElementId(id)}`) into view and flash a highlight ring on it.
// `ready` should flip true once the list has rendered so the element exists.
export function useFocusHighlight(ready: boolean) {
  const focusId = useSearchParams().get("focus");

  useEffect(() => {
    if (!ready || !focusId) return;

    const el = document.getElementById(focusElementId(focusId));
    if (!el) return;

    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add(...RING_CLASSES);
    const timer = setTimeout(() => el.classList.remove(...RING_CLASSES), 2500);

    return () => clearTimeout(timer);
  }, [ready, focusId]);
}
