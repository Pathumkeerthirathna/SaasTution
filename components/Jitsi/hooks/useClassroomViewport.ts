"use client";

import { useEffect, useState } from "react";

// Keep these in step with the media queries in app/globals.css (.sl-classroom).
const PHONE_QUERY = "(max-width: 639px) and (min-height: 501px)";
const SHORT_QUERY = "(max-height: 500px)";
const COARSE_QUERY = "(pointer: coarse)";

export type ClassroomViewport = {
  /** Portrait phone: the rail becomes a bottom bar and panels become bottom sheets. */
  isPhone: boolean;
  /** Very little height (landscape phone, or a very short window). */
  isShort: boolean;
  /**
   * A touch layout: no hover, so the fullscreen "reveal the header / rail at the
   * screen edge" behaviour cannot be used and the normal layout stays visible.
   */
  isTouchLayout: boolean;
};

function read(): ClassroomViewport {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { isPhone: false, isShort: false, isTouchLayout: false };
  }

  const isPhone = window.matchMedia(PHONE_QUERY).matches;
  const isShort = window.matchMedia(SHORT_QUERY).matches;
  const isCoarse = window.matchMedia(COARSE_QUERY).matches;

  return { isPhone, isShort, isTouchLayout: isPhone || (isShort && isCoarse) };
}

/** Which classroom layout mode is active. Client-only; desktop until mounted. */
export function useClassroomViewport(): ClassroomViewport {
  const [viewport, setViewport] = useState<ClassroomViewport>({
    isPhone: false,
    isShort: false,
    isTouchLayout: false,
  });

  useEffect(() => {
    const queries = [PHONE_QUERY, SHORT_QUERY, COARSE_QUERY].map((query) => window.matchMedia(query));
    const update = () => setViewport(read());

    update();
    queries.forEach((query) => query.addEventListener("change", update));

    return () => {
      queries.forEach((query) => query.removeEventListener("change", update));
    };
  }, []);

  return viewport;
}

/**
 * Publishes the visible viewport as CSS variables so bottom sheets can stay above the
 * on-screen keyboard:
 *   --sl-kb   height of the keyboard covering the bottom of the layout viewport (iOS
 *             does not shrink the layout viewport, so this is > 0 there; Android with
 *             `interactive-widget=resizes-content` shrinks it and this stays 0)
 *   --sl-vvh  height of the visible viewport
 */
export function useVisualViewportVars() {
  useEffect(() => {
    const viewport = window.visualViewport;

    if (!viewport) {
      return;
    }

    const root = document.documentElement;

    const update = () => {
      const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);

      root.style.setProperty("--sl-kb", `${Math.round(covered)}px`);
      root.style.setProperty("--sl-vvh", `${Math.round(viewport.height)}px`);
    };

    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);

    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--sl-kb");
      root.style.removeProperty("--sl-vvh");
    };
  }, []);
}
