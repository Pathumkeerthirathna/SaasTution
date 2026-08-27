"use client";

import {
  ChevronLeft,
  ChevronRight,
  Quote,
  Star,
} from "lucide-react";

import { useState } from "react";

import Image from "next/image";

import { ClassTestimonial } from "../../../types/teacherProfileTypes/ClassTestimonial";

interface Props {
  testimonials: ClassTestimonial[];
}

export default function ClassTestimonials({
  testimonials,
}: Props) {
  const [index, setIndex] = useState(0);

  const testimonial = testimonials[index];

  const previous = () =>
    setIndex((prev) =>
      prev === 0 ? testimonials.length - 1 : prev - 1
    );

  const next = () =>
    setIndex((prev) =>
      prev === testimonials.length - 1 ? 0 : prev + 1
    );

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-100">
            <Quote className="h-4 w-4 text-orange-500" />
          </div>

          <div>
            <h2 className="text-[16px] font-bold text-slate-900">
              Student Success Stories
            </h2>
            <p className="mt-0.5 text-[14px] text-slate-500">
              Hear from students who completed this class.
            </p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="p-5">

        <div className="flex flex-col gap-4 sm:flex-row">

          <Image
            src={testimonial.image}
            alt={testimonial.studentName}
            width={72}
            height={72}
            className="h-16 w-16 shrink-0 rounded-xl object-cover shadow-sm"
          />

          <div className="flex-1">

            <div className="flex items-center gap-0.5">
              {Array.from({ length: testimonial.rating }).map((_, i) => (
                <Star
                  key={i}
                  className="h-3.5 w-3.5 fill-orange-400 text-orange-400"
                />
              ))}
            </div>

            <p className="mt-2 text-[14px] italic leading-6 text-slate-700">
              &ldquo;{testimonial.comment}&rdquo;
            </p>

            <div className="mt-3">
              <h3 className="text-[15px] font-bold text-slate-900">
                {testimonial.studentName}
              </h3>
              <p className="mt-0.5 text-[13px] text-slate-500">
                {testimonial.grade} • {testimonial.school}
              </p>
              <span className="mt-1.5 inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[12px] font-semibold text-emerald-700">
                {testimonial.year}
              </span>
            </div>

          </div>

        </div>

        {/* Navigation */}
        <div className="mt-4 flex items-center justify-between">
          <div className="flex gap-1.5">
            {testimonials.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === index ? "w-6 bg-emerald-600" : "w-1.5 bg-slate-300"
                }`}
              />
            ))}
          </div>

          <div className="flex gap-2">
            <button
              onClick={previous}
              aria-label="Previous testimonial"
              className="rounded-lg border border-slate-300 p-1.5 text-slate-600 transition hover:bg-slate-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={next}
              aria-label="Next testimonial"
              className="rounded-lg border border-slate-300 p-1.5 text-slate-600 transition hover:bg-slate-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="mt-4 rounded-xl bg-gradient-to-r from-emerald-600 to-orange-500 p-4 text-white">
          <div className="grid gap-3 text-center sm:grid-cols-3">
            {[
              { value: "4.9", label: "Average Rating" },
              { value: "520+", label: "Happy Students" },
              { value: "96%", label: "Recommend This Class" },
            ].map(({ value, label }) => (
              <div key={label}>
                <div className="text-[20px] font-bold">{value}</div>
                <div className="mt-0.5 text-[13px] text-emerald-50">{label}</div>
              </div>
            ))}
          </div>
        </div>

      </div>

    </div>
  );
}
