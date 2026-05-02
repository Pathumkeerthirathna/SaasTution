const features = [
  {
    title: "Class Management",
    desc: "Organize classes and students easily",
  },
  {
    title: "Attendance Tracking",
    desc: "Automated daily attendance system",
  },
  {
    title: "Bulk Messaging",
    desc: "Send updates via WhatsApp or SMS",
  },
  {
    title: "Live Classes",
    desc: "Conduct online sessions بسهولة",
  },
  {
    title: "Payments",
    desc: "Track student payments and fees",
  },
  {
    title: "Live Quizzes & Exams",
    desc: "Run quizzes during or after class to track student understanding",
  },
  {
    title: "Parent Access",
    desc: "Parents can monitor attendance and student progress in real-time",
  },
  {
    title: "Student Growth Insights",
    desc: "Track performance improvements and identify weak areas",
  },
  
];

export default function Features() {
  return (
    <section id="features" className="bg-gray-50 py-20">
      <div className="max-w-7xl mx-auto px-6 text-center">
        <h2 className="text-3xl font-bold">Everything You Need</h2>

        <div className="grid md:grid-cols-3 gap-8 mt-10">
          {features.map((f, i) => (
            <div key={i} className="bg-white p-6 rounded-xl shadow-sm">
              <h3 className="font-semibold text-lg">{f.title}</h3>
              <p className="text-gray-600 mt-2">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}