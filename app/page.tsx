import AfterClass from "@/components/LandingPage/after-class";
import ControlCenter from "@/components/LandingPage/control-center";
import CTA from "@/components/LandingPage/cta";
import Fees from "@/components/LandingPage/fees";
import LiveClassroom from "@/components/LandingPage/live-classroom";
import PlatformOverview from "@/components/LandingPage/platform-overview";
import RecordCommunicate from "@/components/LandingPage/record-communicate";
import Security from "@/components/LandingPage/security";
import StudentManagement from "@/components/LandingPage/student-management";
import StudentsGuardians from "@/components/LandingPage/students-guardians";
import TeachingTools from "@/components/LandingPage/teaching-tools";
import Footer from "@/components/Layout/footer";
import Hero from "@/components/Layout/hero";
import Navbar from "@/components/Layout/navbar";

export default function Home() {
  return (
    <main className="overflow-x-hidden bg-white text-slate-900">
      <Navbar />
      <Hero />
      <PlatformOverview />
      <ControlCenter />
      <LiveClassroom />
      <TeachingTools />
      <AfterClass />
      <StudentManagement />
      <Fees />
      <StudentsGuardians />
      <RecordCommunicate />
      <Security />
      <CTA />
      <Footer />
    </main>
  );
}
