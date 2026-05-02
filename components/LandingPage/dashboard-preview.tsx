"use client";

export default function DashboardPreview() {
  return (
    <div className="bg-white rounded-xl shadow-lg p-4 w-full h-[320px] overflow-hidden">

      {/* Top Stats */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-blue-50 p-3 rounded-lg">
          <p className="text-xs text-gray-500">Students</p>
          <p className="text-lg font-bold">120</p>
        </div>
        <div className="bg-green-50 p-3 rounded-lg">
          <p className="text-xs text-gray-500">Attendance</p>
          <p className="text-lg font-bold">92%</p>
        </div>
        <div className="bg-purple-50 p-3 rounded-lg">
          <p className="text-xs text-gray-500">Avg Score</p>
          <p className="text-lg font-bold">78%</p>
        </div>
      </div>

      {/* Quiz Table */}
      <div className="text-sm">
        <p className="font-semibold mb-2">Recent Quiz Results</p>

        <div className="space-y-2">
          <div className="flex justify-between bg-gray-50 p-2 rounded">
            <span>Math Quiz</span>
            <span className="text-green-600">85%</span>
          </div>
          <div className="flex justify-between bg-gray-50 p-2 rounded">
            <span>Science Quiz</span>
            <span className="text-yellow-600">70%</span>
          </div>
          <div className="flex justify-between bg-gray-50 p-2 rounded">
            <span>English Quiz</span>
            <span className="text-red-500">55%</span>
          </div>
        </div>
      </div>
    </div>
  );
}