import CTA from "@/components/LandingPage/cta";
import Features from "@/components/LandingPage/features";
import Growth from "@/components/LandingPage/growth";
import HowItWorks from "@/components/LandingPage/how-it-works";
import LiveClassroom from "@/components/LandingPage/live-classroom";
import Parents from "@/components/LandingPage/parents";
import TeacherProfileShowcase from "@/components/LandingPage/teacher-profile-showcase";
import Footer from "@/components/Layout/footer";
import Hero from "@/components/Layout/hero";
import Navbar from "@/components/Layout/navbar";

export default function Home() {
  return (
    <main className="overflow-x-hidden bg-white text-slate-900">
      <Navbar />
      <Hero />
      <Features />
      <LiveClassroom />
      <TeacherProfileShowcase />
      <Parents />
      <Growth />
      <HowItWorks />
      <CTA />
      <Footer />
    </main>
  );
}
