interface Props {
  eyebrow: string;
  title: string;
  description?: string;
  align?: "center" | "left";
}

export default function SectionHeading({
  eyebrow,
  title,
  description,
  align = "center",
}: Props) {
  const isCenter = align === "center";

  return (
    <div className={isCenter ? "mx-auto max-w-2xl text-center" : "max-w-xl"}>
      <span className="inline-flex items-center rounded-full border border-teal-100 bg-teal-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-teal-700">
        {eyebrow}
      </span>

      <h2 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
        {title}
      </h2>

      {description && (
        <p className="mt-3 text-sm leading-relaxed text-slate-600 sm:text-[15px]">
          {description}
        </p>
      )}
    </div>
  );
}
