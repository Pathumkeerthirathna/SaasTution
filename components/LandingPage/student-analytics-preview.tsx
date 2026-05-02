"use client";

export default function StudentAnalyticsPreview() {
  return (
    <div className="bg-white rounded-xl shadow-lg p-4 w-full h-[320px]">

      {/* Header */}
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-semibold text-sm">Student Performance</h3>
        <span className="text-xs text-gray-500">Last 7 days</span>
      </div>

      {/* Fake Chart Area */}
      <div className="h-[120px] bg-gradient-to-r from-blue-50 to-purple-50 rounded-lg flex items-end gap-2 p-2 mb-4">
        {[40, 60, 55, 70, 65, 80, 78].map((h, i) => (
          <div
            key={i}
            className="bg-blue-500 rounded w-3"
            style={{ height: `${h}%` }}
          />
        ))}
      </div>

      {/* Insights */}
      <div className="grid grid-cols-3 gap-3 text-center mb-4">
        <div className="bg-green-50 p-2 rounded">
          <p className="text-xs text-gray-500">Improving</p>
          <p className="text-sm font-bold text-green-600">+12%</p>
        </div>

        <div className="bg-yellow-50 p-2 rounded">
          <p className="text-xs text-gray-500">Average</p>
          <p className="text-sm font-bold text-yellow-600">72%</p>
        </div>

        <div className="bg-red-50 p-2 rounded">
          <p className="text-xs text-gray-500">At Risk</p>
          <p className="text-sm font-bold text-red-500">3</p>
        </div>
      </div>

      {/* Student Alerts */}
      <div className="text-xs space-y-1">
        <div className="flex justify-between bg-gray-50 p-2 rounded">
          <span>Nimal Perera</span>
          <span className="text-red-500">Declining</span>
        </div>
        <div className="flex justify-between bg-gray-50 p-2 rounded">
          <span>Kavindu Silva</span>
          <span className="text-green-600">Improving</span>
        </div>
      </div>
    </div>
  );
}