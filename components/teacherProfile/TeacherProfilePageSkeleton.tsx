export default function Loading() {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-[1800px] px-3 py-4 animate-pulse">

        {/* Cover */}
        <div className="h-56 rounded-3xl bg-slate-200" />

        {/* Profile */}
        <div className="-mt-16 flex flex-col gap-6 lg:flex-row">

          <div className="h-36 w-36 rounded-full border-4 border-white bg-slate-200" />

          <div className="flex-1 space-y-4 pt-12">
            <div className="h-8 w-72 rounded bg-slate-200" />
            <div className="h-5 w-56 rounded bg-slate-200" />
            <div className="h-4 w-96 rounded bg-slate-200" />
          </div>

        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-[320px_1fr]">

          {/* Left */}
          <div className="space-y-6">
            <div className="h-48 rounded-2xl bg-white shadow-sm" />
            <div className="h-56 rounded-2xl bg-white shadow-sm" />
            <div className="h-40 rounded-2xl bg-white shadow-sm" />
          </div>

          {/* Right */}
          <div className="space-y-6">
            <div className="h-72 rounded-2xl bg-white shadow-sm" />
            <div className="h-64 rounded-2xl bg-white shadow-sm" />
            <div className="h-64 rounded-2xl bg-white shadow-sm" />
            <div className="h-64 rounded-2xl bg-white shadow-sm" />
          </div>

        </div>
      </div>
    </div>
  );
}