"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Gentle scroll-in for below-the-fold content. Everything is visible on the server and
 * without JavaScript; the hidden state is only applied after mount, and only to elements
 * that are still below the viewport. Skipped entirely for reduced-motion users.
 */
export default function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"visible" | "hidden">("visible");

  useEffect(() => {
    const node = ref.current;

    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }

    if (node.getBoundingClientRect().top < window.innerHeight * 0.9) {
      return;
    }

    setState("hidden");

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setState("visible");
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -8% 0px" }
    );

    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      style={{ transitionDelay: state === "visible" ? `${delay}ms` : "0ms" }}
      className={`transition-all duration-700 ease-out ${
        state === "hidden" ? "translate-y-5 opacity-0" : "translate-y-0 opacity-100"
      } ${className}`}
    >
      {children}
    </div>
  );
}
