type TeacherHeaderProps = {
  className: string;
  lectureTitle?: string | null;
  teacherName: string;
};

export default function TeacherHeader({
  className,
  lectureTitle,
  teacherName,
}: TeacherHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 bg-black/85 px-4 py-3 text-white sm:px-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-wide text-white/70">
          Class Title
        </p>

        <p className="text-base font-semibold sm:text-lg">
          {className}
        </p>

        <p className="text-xs text-white/70 sm:text-sm">
          Lecture: {lectureTitle ?? "No lecture title"}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-semibold">
          {teacherName}
        </span>

        <span className="rounded-full border border-red-300/30 bg-red-500/20 px-3 py-1 text-xs font-semibold text-red-100">
          LIVE
        </span>
      </div>
    </div>
  );
}