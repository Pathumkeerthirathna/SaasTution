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

  const testimonial =
    testimonials[index];

  const previous = () =>
    setIndex((prev) =>
      prev === 0
        ? testimonials.length - 1
        : prev - 1
    );

  const next = () =>
    setIndex((prev) =>
      prev === testimonials.length - 1
        ? 0
        : prev + 1
    );

  return (
    <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">

      {/* Header */}

      <div className="border-b border-slate-100 bg-gradient-to-r from-orange-50 via-white to-emerald-50 px-6 py-5">

        <div className="flex items-center justify-between">

          <div>

            <h2 className="text-xl font-bold text-slate-900">
              Student Success Stories
            </h2>

            <p className="mt-1 text-sm text-slate-500">
              Hear from students who have
              successfully completed this class.
            </p>

          </div>

          <Quote className="h-9 w-9 text-orange-500" />

        </div>

      </div>

      {/* Body */}

      <div className="p-8">

        <div className="flex flex-col gap-8 lg:flex-row">

          {/* Left */}

          <div className="shrink-0">

            <Image
              src={testimonial.image}
              alt={testimonial.studentName}
              width={112}
              height={112}
              className="h-28 w-28 rounded-2xl object-cover shadow-md"
            />

          </div>

          {/* Right */}

          <div className="flex-1">

            <div className="flex items-center gap-1">

              {Array.from({
                length: testimonial.rating,
              }).map((_, i) => (
                <Star
                  key={i}
                  className="h-5 w-5 fill-orange-400 text-orange-400"
                />
              ))}

            </div>

            <p className="mt-5 text-lg leading-9 text-slate-700 italic">
              &ldquo;{testimonial.comment}&rdquo;
            </p>

            <div className="mt-6">

              <h3 className="text-xl font-bold text-slate-900">
                {testimonial.studentName}
              </h3>

              <p className="mt-1 text-sm text-slate-500">
                {testimonial.grade} •{" "}
                {testimonial.school}
              </p>

              <span className="mt-3 inline-flex rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                {testimonial.year}
              </span>

            </div>

          </div>

        </div>

        {/* Navigation */}

        <div className="mt-8 flex items-center justify-between">

          <div className="flex gap-2">

            {testimonials.map((_, i) => (

              <div
                key={i}
                className={`h-2 rounded-full transition-all ${
                  i === index
                    ? "w-8 bg-emerald-600"
                    : "w-2 bg-slate-300"
                }`}
              />

            ))}

          </div>

          <div className="flex gap-3">

            <button
              onClick={previous}
              className="rounded-xl border border-slate-300 p-3 transition hover:bg-slate-50"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>

            <button
              onClick={next}
              className="rounded-xl border border-slate-300 p-3 transition hover:bg-slate-50"
            >
              <ChevronRight className="h-5 w-5" />
            </button>

          </div>

        </div>

        {/* Bottom */}

        <div className="mt-8 rounded-3xl bg-gradient-to-r from-emerald-600 to-orange-500 p-6 text-white">

          <div className="grid gap-6 md:grid-cols-3">

            <div className="text-center">

              <div className="text-4xl font-bold">
                4.9
              </div>

              <div className="mt-2 text-sm text-emerald-50">
                Average Rating
              </div>

            </div>

            <div className="text-center">

              <div className="text-4xl font-bold">
                520+
              </div>

              <div className="mt-2 text-sm text-emerald-50">
                Happy Students
              </div>

            </div>

            <div className="text-center">

              <div className="text-4xl font-bold">
                96%
              </div>

              <div className="mt-2 text-sm text-emerald-50">
                Recommend This Class
              </div>

            </div>

          </div>

        </div>

      </div>

    </div>
  );
}