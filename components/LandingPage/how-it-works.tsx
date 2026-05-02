export default function HowItWorks() {
  return (
    <section id="how" className="py-20">
      <div className="max-w-5xl mx-auto px-6 text-center">
        <h2 className="text-3xl font-bold">How It Works</h2>

        <div className="grid md:grid-cols-3 gap-8 mt-10">
          <div>
            <h3 className="font-semibold">1. Create Account</h3>
            <p className="text-gray-600 mt-2">Sign up as a teacher</p>
          </div>

          <div>
            <h3 className="font-semibold">2. Add Classes</h3>
            <p className="text-gray-600 mt-2">Add students and schedules</p>
          </div>

          <div>
            <h3 className="font-semibold">3. Start Teaching</h3>
            <p className="text-gray-600 mt-2">Manage everything easily</p>
          </div>
        </div>
      </div>
    </section>
  );
}