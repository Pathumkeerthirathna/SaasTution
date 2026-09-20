import { ArrowRight, Bell, Mail, MessageSquare, Radio, Video, Play } from "lucide-react";

import Reveal from "./reveal";
import Shot from "./shot";
import { CheckList, Container, Frame, SectionHead } from "./ui";

export default function RecordCommunicate() {
  return (
    <section id="communicate" className="scroll-mt-20 bg-slate-50 py-16 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            eyebrow="YouTube & communication"
            title="Record, Go Live and Stay in Touch"
            lead="Publish your classes to your own YouTube channel and keep students informed."
          />
        </Reveal>

        <div className="mt-12 grid items-center gap-8 lg:grid-cols-2 lg:gap-12">
          <Reveal>
            <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-[#112D5C] px-3 py-2 text-white"><Video className="h-4 w-4" />Teacher</span>
              <ArrowRight className="h-4 w-4 text-teal-500" />
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-2 text-white"><Radio className="h-4 w-4" />SL Classroom</span>
              <ArrowRight className="h-4 w-4 text-teal-500" />
              <span className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-white"><Play className="h-4 w-4" />YouTube</span>
            </div>
            <h3 className="mt-6 text-2xl font-bold text-slate-900">To your own YouTube channel</h3>
            <div className="mt-4">
              <CheckList items={["Connect your YouTube channel", "Record a class", "Go live as Public, Unlisted or Private", "Recordings and live streams sit with the lecture"]} />
            </div>
            <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h4 className="text-[15px] font-bold text-slate-900">Communication</h4>
              <ul className="mt-3 grid gap-2.5 sm:grid-cols-2">
                {[
                  [Bell, "In-app announcements"],
                  [Mail, "Email announcements"],
                  [Mail, "Delivery tracking"],
                  [Mail, "Absent notices by email"],
                  [MessageSquare, "Class chat"],
                ].map(([Icon, label]) => {
                  const I = Icon as typeof Bell;
                  return (
                    <li key={label as string} className="flex items-center gap-2 text-[13.5px] text-slate-700">
                      <I className="h-4 w-4 text-teal-600" />
                      {label as string}
                    </li>
                  );
                })}
              </ul>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <Frame title="SL Classroom · Record & go live">
              <Shot name="classroom-golive" scrollOnMobile alt="The Start Live dialog with Public, Unlisted and Private options" />
            </Frame>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
