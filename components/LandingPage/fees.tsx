import { FileCheck2, Percent, Wallet } from "lucide-react";

import Reveal from "./reveal";
import Shot from "./shot";
import { CheckList, Container, Frame, SectionHead } from "./ui";

export default function Fees() {
  return (
    <section id="fees" className="scroll-mt-20 bg-slate-50 py-16 sm:py-24">
      <Container>
        <Reveal>
          <SectionHead
            eyebrow="Fees & payments"
            title="Keep Track of Every Payment"
            lead="See who has paid, who is pending and who is unpaid, class by class."
          />
        </Reveal>

        <div className="mt-12 grid grid-cols-1 items-center gap-8 xl:grid-cols-[1fr_1.9fr] xl:gap-10">
          <Reveal className="order-2 xl:order-1">
            <ul className="space-y-4">
              <li className="flex gap-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><Wallet className="h-5 w-5" /></span>
                <span>
                  <span className="block text-[15px] font-bold text-slate-900">A fee sheet per class</span>
                  <span className="block text-[14px] text-slate-600">Status shows Paid, Pending or Unpaid for each student.</span>
                </span>
              </li>
              <li className="flex gap-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><Percent className="h-5 w-5" /></span>
                <span>
                  <span className="block text-[15px] font-bold text-slate-900">Discounts and adjustments</span>
                  <span className="block text-[14px] text-slate-600">Apply discounts, late deductions or waivers and see the final amount.</span>
                </span>
              </li>
              <li className="flex gap-3.5">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-700"><FileCheck2 className="h-5 w-5" /></span>
                <span>
                  <span className="block text-[15px] font-bold text-slate-900">Payment slips, confirmed by you</span>
                  <span className="block text-[14px] text-slate-600">Students send payment proof and you confirm it. Payments are not taken online.</span>
                </span>
              </li>
            </ul>
            <div className="mt-6">
              <CheckList items={["Guardians can see payment standing"]} />
            </div>
          </Reveal>

          <Reveal delay={120} className="order-1 xl:order-2">
            <Frame title="SL Classroom · Payments">
              <Shot name="dash-fees" scrollOnMobile alt="The fee sheet showing discounts, final amounts and Paid, Pending and Unpaid status" />
            </Frame>
          </Reveal>
        </div>
      </Container>
    </section>
  );
}
