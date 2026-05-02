export default function Parents() {
  return (
    <section className="bg-gray-50 py-20">
      <div className="max-w-6xl mx-auto px-6 text-center">

        <h2 className="text-3xl font-bold">
          Keep Parents Informed & Engaged
        </h2>

        <p className="mt-4 text-gray-600 max-w-2xl mx-auto">
          Give parents access to their child’s attendance, performance, and progress — building trust and transparency.
        </p>

        <div className="grid md:grid-cols-3 gap-8 mt-10">
          <div className="bg-white p-6 rounded-xl">
            <h3 className="font-semibold">Attendance Reports</h3>
            <p className="text-gray-600 mt-2">
              Parents can track daily attendance easily
            </p>
          </div>

          <div className="bg-white p-6 rounded-xl">
            <h3 className="font-semibold">Performance Insights</h3>
            <p className="text-gray-600 mt-2">
              View quiz results and academic progress
            </p>
          </div>

          <div className="bg-white p-6 rounded-xl">
            <h3 className="font-semibold">Student Profile</h3>
            <p className="text-gray-600 mt-2">
              Full view of student activity and growth
            </p>
          </div>
        </div>

      </div>
    </section>
  );
}