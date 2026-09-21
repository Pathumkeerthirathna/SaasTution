"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";

import Shot from "./shot";
import { Frame } from "./ui";

export type Pin = {
  id: string;
  label: string;
  text: string;
  /** Position on the screenshot, in percent of its width / height. */
  x: number;
  y: number;
  icon: LucideIcon;
};

/**
 * The real classroom screenshot with numbered pins on the parts of the interface. The pins
 * are hidden on phones (the phone screenshot has a different layout); the numbered legend
 * underneath carries the same information there.
 */
export default function HotspotFigure({ image, alt, pins }: { image: string; alt: string; pins: Pin[] }) {
  const [active, setActive] = useState<string | null>(null);

  return (
    <div>
      <Frame dark title="SL Classroom · Live class (teacher view)">
        <div className="relative">
          <Shot name={image} mobile alt={alt} priority />

          <div className="absolute inset-0 max-sm:hidden">
            {pins.map((pin, index) => {
              const isActive = active === pin.id;
              const tooltipOnLeft = pin.x > 55;

              return (
                <div
                  key={pin.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: `${pin.x}%`, top: `${pin.y}%`, zIndex: isActive ? 30 : 10 }}
                >
                  <button
                    type="button"
                    aria-label={`${index + 1}. ${pin.label}`}
                    onMouseEnter={() => setActive(pin.id)}
                    onMouseLeave={() => setActive(null)}
                    onFocus={() => setActive(pin.id)}
                    onBlur={() => setActive(null)}
                    className="group relative flex h-5 w-5 items-center justify-center rounded-full bg-teal-500 text-[10px] lg:h-7 lg:w-7 lg:text-[12px] font-bold text-white shadow-lg ring-1 ring-white/90 lg:ring-2 transition hover:scale-110 focus:outline-none focus-visible:ring-4 focus-visible:ring-teal-300"
                  >
                    <span className="absolute inset-0 rounded-full bg-teal-400/50 motion-safe:animate-ping [animation-duration:2.6s]" />
                    <span className="relative">{index + 1}</span>
                  </button>

                  {isActive ? (
                    <div
                      role="tooltip"
                      className={`pointer-events-none absolute top-1/2 w-52 -translate-y-1/2 rounded-xl border border-white/10 bg-slate-900/95 p-3 text-left shadow-2xl backdrop-blur ${
                        tooltipOnLeft ? "right-full mr-3" : "left-full ml-3"
                      }`}
                    >
                      <p className="text-[13px] font-semibold text-white">{pin.label}</p>
                      <p className="mt-1 text-[12px] leading-snug text-slate-300">{pin.text}</p>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </Frame>

      <ol className="mt-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {pins.map((pin, index) => {
          const Icon = pin.icon;
          const isActive = active === pin.id;

          return (
            <li key={pin.id}>
              <button
                type="button"
                onMouseEnter={() => setActive(pin.id)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(pin.id)}
                onBlur={() => setActive(null)}
                className={`flex h-full w-full items-start gap-3 rounded-xl border p-3 text-left transition ${
                  isActive
                    ? "border-teal-300/60 bg-white/10"
                    : "border-white/10 bg-white/[0.04] hover:bg-white/[0.08]"
                }`}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-500 text-[11px] font-bold text-white">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-white">
                    <Icon className="h-3.5 w-3.5 shrink-0 text-teal-300" />
                    {pin.label}
                  </span>
                  <span className="mt-1 block text-[12.5px] leading-snug text-slate-400">{pin.text}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
