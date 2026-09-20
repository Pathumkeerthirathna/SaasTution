import { ArrowRight, ClipboardCheck, PenTool, UsersRound } from "lucide-react";

import Reveal from "./reveal";
import Shot from "./shot";
import { CheckList, Container, Eyebrow, Frame, SectionHead } from "./ui";

function Feature({
  icon: Icon,
  eyebrow,
  title,
  text,
  points,
  flip = false,
  children,
}: {
  icon: typeof PenTool;
  eyebrow: string;
  title: string;
  text: string;
  points: string[];
  flip?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Reveal>
      <div className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
        <div className={flip ? "lg:order-2" : ""}>
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-teal-600 text-white shadow-md">
            <Icon className="h-5 w-5" />
          </span>
          <div className="mt-4">
            <Eyebrow>{eyebrow}</Eyebrow>
          </div>
          <h3 className="mt-3 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h3>
          <p className="mt-3 text-[15px] leading-relaxed text-slate-600 sm:text-base">{text}</p>
          <div className="mt-5">
            <CheckList items={points} />
          </div>
        </div>
        <div className={flip ? "lg:order-1" : ""}>{children}</div>
      </div>
    </Reveal>
  );
}

function Room({ label, tone }: { label: string; tone: string }) {
  return <span className={`rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white ${tone}`}>{label}</span>;
}

export default function TeachingTools() {
  return (
    <section id="tools" className="scroll-mt-20 bg-white py-16 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            eyebrow="Inside every live class"
            title="Whiteboard, Breakout Rooms and Attendance"
            lead="The tools that make a live class more than a video call, built into the same session."
          />
        </Reveal>

        <div className="mt-14 space-y-20 sm:space-y-28">
          <Feature
            icon={PenTool}
            eyebrow="Live whiteboard"
            title="Explain it the way you would on a board"
            text="Open a whiteboard for the lecture and draw, write and diagram while students follow along live."
            points={["Opens from inside the classroom", "Saved with the lecture, so it is there next time", "Works alongside screen sharing"]}
          >
            <Frame title="SL Classroom · Whiteboard">
              <Shot name="classroom-whiteboard" mobile alt="The live whiteboard in a class, with a worked parabola example" />
            </Frame>
          </Feature>

          <Feature
            flip
            icon={UsersRound}
            eyebrow="Breakout rooms"
            title="Split the class, then bring everyone back"
            text="Send students into smaller rooms for group work, then return them to the main class."
            points={["Create rooms and place students", "Students see their own room from their side", "Everyone returns to the main class"]}
          >
            <div className="space-y-4">
              <Frame title="Teacher view">
                <Shot name="classroom-breakout" mobile alt="The breakout rooms panel in the teacher view" />
              </Frame>
              <div className="grid grid-cols-2 gap-4">
                <Frame title="Student view">
                  <Shot name="classroom-breakout-student" mobile alt="A student's view of their breakout room" tag={false} />
                </Frame>
                <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center">
                  <Room label="Main class" tone="bg-[#112D5C]" />
                  <ArrowRight className="h-4 w-4 rotate-90 text-teal-600" />
                  <div className="flex flex-wrap justify-center gap-1.5">
                    <Room label="Room A" tone="bg-teal-600" />
                    <Room label="Room B" tone="bg-sky-600" />
                    <Room label="Room C" tone="bg-violet-600" />
                  </div>
                  <p className="mt-1 text-[11.5px] text-slate-500">Illustration</p>
                </div>
              </div>
            </div>
          </Feature>

          <Feature
            icon={ClipboardCheck}
            eyebrow="Attendance"
            title="Know who was there, without a roll call"
            text="Open the class register during the session and keep attendance with the lecture."
            points={["Class register inside the classroom", "Attendance kept per session", "Absent students can be emailed a notice"]}
          >
            <div className="space-y-4">
              <Frame title="Attendance">
                <Shot name="classroom-attendance" scrollOnMobile alt="The attendance panel listing present and absent students" />
              </Frame>
            </div>
          </Feature>
        </div>
      </Container>
    </section>
  );
}
