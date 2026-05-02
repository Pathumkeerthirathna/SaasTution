import Link from "next/link";

export default function Navbar() {
  return (
    <nav className="w-full border-b bg-white">
      <div className="max-w-7xl mx-auto px-6 py-4 flex justify-between items-center">
        <h1 className="text-xl font-semibold">SmartClass</h1>

        <div className="flex items-center gap-6">
          <Link href="#features">Features</Link>
          <Link href="#how">How it works</Link>

          <Link
            href="/login"
            className="text-sm font-medium text-gray-600"
          >
            Login
          </Link>

          <Link
            href="/register"
            className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-700"
          >
            Start Free Trial
          </Link>
        </div>
      </div>
    </nav>
  );
}