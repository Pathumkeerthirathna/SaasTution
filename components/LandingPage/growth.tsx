import StudentAnalyticsPreview from "./student-analytics-preview";

export default function Growth() {
  return (
    <section className="bg-white py-20">
      <div className="max-w-6xl mx-auto px-6 grid md:grid-cols-2 gap-10 items-center">

       <StudentAnalyticsPreview />

        <div>
          <h2 className="text-3xl font-bold">
            Track Student Growth — Not Just Attendance
          </h2>

          <p className="mt-4 text-gray-600">
            Monitor how each student performs over time using quiz results and attendance data. 
            Easily identify improvement or decline and take action early.
          </p>

          <ul className="mt-6 space-y-3 text-gray-700">
            <li>✔ Quiz-based performance tracking</li>
            <li>✔ Identify weak students instantly</li>
            <li>✔ Share progress with parents</li>
            <li>✔ Make data-driven teaching decisions</li>
          </ul>
        </div>

      </div>
    </section>
  );
}