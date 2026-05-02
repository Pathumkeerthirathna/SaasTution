import DashboardPreview from "../LandingPage/dashboard-preview";

export default function Hero() {
  return (
    <section className="max-w-7xl mx-auto px-6 py-20 grid md:grid-cols-2 gap-10 items-center">
      
      <div>
        <h1 className="text-4xl md:text-5xl font-bold leading-tight">
          Run Your Classes Online — <br /> The Smart Way
        </h1>

        <p className="mt-4 text-gray-600 text-lg">
          
          Conduct live classes, run quizzes, monitor attendance,payments and give parents real-time visibility — all in one platform.
        </p>

        <div className="mt-6 flex gap-4">
          <a
            href="/register"
            className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700"
          >
            Start Free Trial
          </a>

          <a
            href="/demo"
            className="border px-6 py-3 rounded-lg hover:bg-gray-100"
          >
            Try Demo
          </a>
        </div>
      </div>

      <DashboardPreview />
    </section>
  );
}