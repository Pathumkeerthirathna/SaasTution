"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";

import Shot from "./shot";
import { Frame } from "./ui";

export type PanelTab = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Screenshot file name (without extension) in /public/landing. */
  image: string;
  /** A phone-layout capture called `<image>-m.webp` exists. */
  mobile?: boolean;
  title: string;
  text: string;
  points?: string[];
};

/**
 * Tabs over real product screenshots. Only the selected screenshot is in the page, so the
 * others cost nothing until they are opened.
 */
export default function PanelTabs({
  tabs,
  dark = false,
  frameTitle,
}: {
  tabs: PanelTab[];
  dark?: boolean;
  frameTitle: string;
}) {
  const [activeId, setActiveId] = useState(tabs[0].id);
  const listRef = useRef<HTMLDivElement | null>(null);
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === activeId);
    let next = index;

    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else return;

    event.preventDefault();
    setActiveId(tabs[next].id);
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  }

  return (
    <div>
      <div
        ref={listRef}
        role="tablist"
        aria-label={frameTitle}
        onKeyDown={onKeyDown}
        className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:justify-center sm:overflow-visible sm:px-0"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = tab.id === activeId;

          return (
            <button
              key={tab.id}
              role="tab"
              type="button"
              id={`tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveId(tab.id)}
              className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3.5 py-2 text-[13px] font-semibold transition ${
                selected
                  ? dark
                    ? "border-teal-400 bg-teal-500 text-white shadow-lg shadow-teal-900/30"
                    : "border-teal-600 bg-teal-600 text-white shadow-md shadow-teal-900/10"
                  : dark
                    ? "border-white/15 bg-white/5 text-slate-300 hover:bg-white/10"
                    : "border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:text-teal-700"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`panel-${active.id}`}
        aria-labelledby={`tab-${active.id}`}
        className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)] lg:gap-8"
      >
        <div className="order-2 lg:order-1 lg:pt-4">
          <h3 className={`text-xl font-bold leading-snug sm:text-2xl ${dark ? "text-white" : "text-slate-900"}`}>{active.title}</h3>
          <p className={`mt-3 text-[15px] leading-relaxed ${dark ? "text-slate-300" : "text-slate-600"}`}>{active.text}</p>
          {active.points ? (
            <ul className="mt-4 space-y-2">
              {active.points.map((point) => (
                <li key={point} className={`flex items-start gap-2 text-[14px] ${dark ? "text-slate-200" : "text-slate-700"}`}>
                  <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dark ? "bg-teal-300" : "bg-teal-500"}`} />
                  {point}
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <Frame dark={dark} title={frameTitle} className="order-1 lg:order-2">
          <Shot key={active.image} name={active.image} mobile={active.mobile} scrollOnMobile={!active.mobile} alt={`${active.label}: ${active.title}`} />
        </Frame>
      </div>
    </div>
  );
}
