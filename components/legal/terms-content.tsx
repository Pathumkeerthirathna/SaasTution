
import {
  ContactDetails,
  List,
  Note,
  P,
  PageLink,
  Sub,
  type LegalSection,
} from "@/components/legal/LegalPage";
import { LEGAL_BUSINESS_DETAILS, LEGAL_PLATFORM } from "@/lib/legal/config";

/*
 * Terms & Conditions (/terms).
 *
 * This policy reflects the current SL Classroom operating model:
 *
 * - SL Classroom is an online education technology platform.
 * - Teachers independently operate and manage their classes.
 * - Teachers set their own tuition fees and manage their students.
 * - Students pay tuition fees directly to their teachers.
 * - Students can submit payment records and slips for teacher confirmation.
 * - No integrated online tuition payment gateway is currently available.
 * - Teachers are responsible for their educational services and tuition
 *   payment arrangements.
 * - SL Classroom earns revenue through teacher subscription plans.
 * - SL Classroom retains authority to manage and enforce platform rules.
 *
 * This document is a draft. See lib/legal/config.ts for outstanding
 * business and legal decisions.
 */

const NAME = LEGAL_PLATFORM.name;

export const termsIntro = (
  <p>
    These Terms &amp; Conditions explain the rules for using {NAME}: what the
    platform provides, what teachers, students and guardians are responsible
    for, and how payments, content and accounts are handled. Please read them
    carefully before using the platform.
  </p>
);

export const termsSections: LegalSection[] = [
  {
    id: "introduction",
    title: "Introduction",
    content: (
      <>
        <P>
          {NAME} ({LEGAL_PLATFORM.website}) is an online education management
          and virtual classroom platform that provides technology and tools
          for independent teachers to manage and conduct their classes. It
          enables teachers to manage their students, organise learning
          activities, conduct online classes, and provide access to relevant
          learning materials.
        </P>

        <P>
          Teachers independently operate their classes, establish their fees,
          manage their students, and collect tuition payments directly from
          students or their parents. {NAME} provides access to its platform
          and related features on a subscription basis. {NAME} does not act
          as a tuition collection agent or payment intermediary between
          teachers and students. Teachers are independently responsible for
          the classes they conduct and the arrangements they make with their
          students.
        </P>

        <P>
          In these Terms, &ldquo;{NAME}&rdquo;, &ldquo;we&rdquo;,
          &ldquo;us&rdquo; and &ldquo;our&rdquo; mean the operator of the
          platform
          {LEGAL_BUSINESS_DETAILS.operatorName ? (
            <> ({LEGAL_BUSINESS_DETAILS.operatorName})</>
          ) : null}.
          &ldquo;Teacher&rdquo; means an independent teacher or tutor who uses
          the platform to provide classes. &ldquo;Student&rdquo; means a
          person enrolled in a teacher&rsquo;s class, and
          &ldquo;guardian&rdquo; means a parent or guardian given access to a
          student&rsquo;s information. &ldquo;You&rdquo; means anyone who
          uses the platform.
        </P>

        <P>
          These Terms apply together with our{" "}
          <PageLink href="/privacy">Privacy Policy</PageLink> and our{" "}
          <PageLink href="/refund-policy">
            Refund &amp; Cancellation Policy
          </PageLink>.
        </P>
      </>
    ),
  },

  {
    id: "acceptance",
    title: "Acceptance of Terms",
    content: (
      <>
        <P>
          By creating an account, signing in, registering for a class or
          otherwise using {NAME}, you confirm that you have read and agree to
          these Terms. If you do not agree, please do not use the platform.
        </P>

        <P>
          If you use the platform on behalf of a student who is a minor, or
          if you are a minor using it with the permission of a parent or
          guardian, the parent or guardian is responsible for reviewing
          these Terms and for the student&rsquo;s use of the platform.
        </P>
      </>
    ),
  },

  {
    id: "services",
    title: `Description of ${NAME} Services`,
    content: (
      <>
        <P>
          Depending on how a teacher sets up their classes and subscription
          plan, the platform may provide:
        </P>

        <List
          items={[
            "Teacher accounts, public teacher profile pages and public class pages where students can register.",
            "Class, schedule and calendar management, and student enrolment, approval and management.",
            "Live online classrooms with video, audio, screen sharing, shared whiteboards and breakout rooms.",
            "Optional lecture recording functionality.",
            "YouTube Live Streaming functionality that allows teachers to broadcast classes through their own connected YouTube channels.",
            "Recorded lectures, notes, study materials, assignments, quizzes and papers, with student submissions.",
            "Attendance tracking, including QR code attendance.",
            "Monthly class fee records, payment records submitted by students and payment confirmation by teachers.",
            "Class messages and announcements from teachers, message threads about papers and payments, and a guardian portal.",
            "Account security features such as email-based password reset and approval of the devices students sign in from.",
          ]}
        />

        <P>
          Features may change over time. Some features may only be available
          on certain teacher subscription plans or when a teacher has enabled
          them.
        </P>
      </>
    ),
  },

  {
    id: "role-of-platform",
    title: `Role of ${NAME}`,
    content: (
      <>
        <P>
          {NAME} provides technology and platform services that enable
          independent teachers to manage and conduct their classes. Teachers
          on the platform are independent education service providers. They
          are not our employees or agents, and we do not provide their tuition
          or educational services.
        </P>

        <P>Each teacher is independently responsible for the educational services they offer, including:</P>

        <List
          items={[
            "the subjects, content, quality and delivery of their classes;",
            "their class schedules, cancellations and rescheduling;",
            "the tuition fees they charge and the payment arrangements they agree with their students;",
            "their students' enrolment, attendance, assessments and progress;",
            "the management of tuition payments, refunds, credits and replacement classes; and",
            "communication and arrangements they make directly with their students and guardians.",
          ]}
        />

        <P>
          We provide, maintain and secure the platform, and we may take
          appropriate action to enforce these Terms. Teacher accounts are
          reviewed by an administrator before they are activated. That review
          is not a check of a teacher&rsquo;s qualifications, background or
          teaching quality, and we do not guarantee them. Students and
          guardians should make their own decisions when choosing a teacher.
        </P>
      </>
    ),
  },

  {
    id: "teacher-responsibilities",
    title: "Independent Teacher Responsibilities",
    content: (
      <>
        <P>If you use {NAME} as a teacher, you agree to:</P>

        <List
          items={[
            "keep your profile, qualifications, subjects and other public information accurate and up to date;",
            "describe your classes, schedules and tuition fees accurately and clearly;",
            "keep your class schedules up to date and conduct the classes you advertise;",
            "provide the educational services you have offered to your enrolled students;",
            "tell your students about schedule changes and cancellations in good time;",
            "handle your students' enrolment, approvals, attendance, assessments and payment records fairly and accurately;",
            "manage tuition payments, cancellations, refunds, credits and replacement classes directly with your students;",
            "use students' and guardians' personal information only for teaching and managing your classes, and keep it confidential;",
            "make sure you have the rights to any material you upload or share in your classes;",
            "inform participants when a session is being recorded or broadcast and obtain any necessary permissions or consent; and",
            "follow these Terms, our other policies and the laws that apply to your teaching.",
          ]}
        />
      </>
    ),
  },

  {
    id: "student-responsibilities",
    title: "Student Responsibilities",
    content: (
      <>
        <P>If you use {NAME} as a student, you agree to:</P>

        <List
          items={[
            "give accurate information when you register or are registered by your teacher;",
            "keep your password and your approved devices secure, and not share your account with anyone;",
            "attend your classes according to the schedule your teacher sets;",
            "treat teachers and other students with respect, in live classes, breakout rooms and messages;",
            "follow your teacher's classroom rules;",
            "not record, copy, download, share or publish lectures, recordings or materials unless your teacher allows it; and",
            "follow the tuition payment arrangements agreed with your teacher.",
          ]}
        />

        <P>
          Guardians who use the guardian portal agree to use it only to
          follow the progress of the students linked to their account, and to
          keep their own login details secure.
        </P>
      </>
    ),
  },

  {
    id: "accounts",
    title: "User Registration and Accounts",
    content: (
      <>
        <Sub>Teacher accounts</Sub>

        <P>
          Teachers register with their name, email address and contact
          details. A teacher account must be approved by an administrator
          before it can be used, and the email address may need to be
          confirmed.
        </P>

        <Sub>Student accounts</Sub>

        <P>
          A student account is created when a teacher adds the student, or
          when the student registers through a teacher&rsquo;s public class
          page. A self-registered student must be approved by that teacher
          before they can take part in the class. Login details are sent to
          the student&rsquo;s email address, and the student may be asked to
          set their own password when they first sign in.
        </P>

        <Sub>Device approval</Sub>

        <P>
          To protect classes, a student may only be able to sign in from
          devices their teacher has approved. Signing in from a new device
          may require a new approval.
        </P>

        <Sub>Your responsibility</Sub>

        <P>
          You are responsible for keeping your account information accurate
          and your password confidential, and for activity that happens
          under your account. Tell your teacher or contact us promptly if
          you think someone else has accessed your account.
        </P>
      </>
    ),
  },

  {
    id: "scheduling-attendance",
    title: "Class Scheduling and Attendance",
    content: (
      <>
        <P>
          Teachers create their classes and schedule lectures and sessions
          on the platform. Students can see the schedules for the classes
          they are enrolled in and join live sessions from their student
          portal.
        </P>

        <P>
          Attendance may be recorded automatically when a student joins a
          live session or scans a QR code, or it may be marked by the
          teacher. Teachers can review and correct attendance records.
          Attendance records may be visible to the student, the
          student&rsquo;s linked guardians and the teacher.
        </P>

        <P>
          Schedules can change. Teachers are responsible for keeping their
          schedules up to date, and students should check their schedule
          regularly.
        </P>
      </>
    ),
  },

  {
    id: "live-recorded",
    title: "Live Classrooms and Recorded Lectures",
    content: (
      <>
        <P>
          {NAME} provides online classroom functionality that enables
          teachers and students to participate in live classes through the
          platform. To use relevant classroom features, participants may
          need to allow their browsers to access their cameras and
          microphones. Participants can control their camera and microphone
          settings, subject to the classroom activities and requirements
          established by the teacher.
        </P>

        <P>
          Teachers may record live sessions where recording functionality is
          available. Teachers are responsible for informing participants
          about recordings and ensuring that any necessary permissions or
          consent are obtained before recording.
        </P>

        <P>
          Teachers may connect their own YouTube channels to use YouTube
          Live Streaming functionality to broadcast classes through YouTube.
          Teachers are responsible for managing their YouTube accounts,
          livestream settings, audience access and compliance with
          YouTube&rsquo;s applicable terms and policies.
        </P>

        <P>
          Teachers are responsible for deciding who may access recordings
          made available through the platform. A recording may contain
          participants&rsquo; names, voices, video, messages and other
          information shared during a class.
        </P>

        <P>
          Students must not independently record live classes, or copy or
          share recordings, unless the teacher permits it.
        </P>
      </>
    ),
  },

  {
    id: "intellectual-property",
    title: "Educational Content and Intellectual Property",
    content: (
      <>
        <Sub>Teacher content</Sub>

        <P>
          Teachers keep ownership of the lectures, recordings, notes, papers,
          quizzes and other materials they create and upload. By uploading
          content, a teacher allows {NAME} to store, process and display it,
          and to make it available to the students and guardians the teacher
          chooses, only as needed to operate and provide the platform.
        </P>

        <Sub>Student content</Sub>

        <P>
          Students keep ownership of the assignments, answers and other
          work they submit. By submitting work, a student allows their
          teacher to view, assess and comment on it, and allows {NAME} to
          store and process it to provide the service.
        </P>

        <Sub>Permitted use</Sub>

        <P>
          Class materials and recordings are for the personal learning of
          the enrolled students. They must not be copied, sold, published or
          shared outside the class without the teacher&rsquo;s permission.
        </P>

        <Sub>The platform</Sub>

        <P>
          The {NAME} software, name, logo and design belong to the operator
          of {NAME} or its licensors. You may use them only to use the
          platform as these Terms allow.
        </P>

        <P>
          If you believe content on the platform infringes your rights,
          contact us using the details in the Contact Information section.
        </P>
      </>
    ),
  },

  {
    id: "acceptable-use",
    title: "Communication and Acceptable Use",
    content: (
      <>
        <P>
          When using {NAME}, including live classes, breakout rooms,
          messages and uploads, you must not:
        </P>

        <List
          items={[
            "harass, bully, threaten, intimidate or discriminate against anyone;",
            "share content that is illegal, sexually explicit, violent, hateful or otherwise inappropriate for an educational setting, especially where minors are present;",
            "pretend to be someone else, or share your account or login details;",
            "try to access accounts, classes, recordings or data you are not permitted to access;",
            "get around security features such as device approval, attendance checks or rate limits;",
            "upload viruses or harmful code, or disrupt or overload the platform;",
            "scrape, copy or collect other users' personal information; or",
            "use the platform for advertising, spam or anything unrelated to education.",
          ]}
        />

        <P>
          Teachers can manage the conduct of participants in their classes.
          We may remove content or restrict accounts that break these rules
          or otherwise misuse the platform.
        </P>
      </>
    ),
  },

  {
    id: "fees-payments",
    title: "Tuition Fees and Payments",
    content: (
      <>
        <Sub>Tuition fees</Sub>

        <P>
          Tuition fees are set by each teacher and are paid by students
          directly to their teacher for the teacher&rsquo;s classes. A
          teacher may charge a monthly fee for a class, or agree other
          arrangements, such as per-class fees, directly with their students.
          Any discount, waiver or other adjustment is decided by the teacher.
        </P>

        <Sub>Student Tuition Payments and Payment Confirmation</Sub>

        <P>
          {NAME} currently does not provide an integrated online payment
          gateway for student tuition fees. Students, or their parents or
          guardians, pay their teacher directly using ATM or bank deposits,
          online banking or another payment method agreed with the teacher.
          The platform records the monthly fee for each enrolled student.
        </P>

        <P>
          Students can upload a payment slip or other payment evidence
          through {NAME}. The teacher independently reviews the submitted
          evidence and manually confirms the payment status, or asks the
          student for clarification. A payment is shown as confirmed only
          after the teacher has confirmed it.
        </P>

        <P>
          {NAME} provides payment record management functionality only. It
          does not collect, hold, process or transfer student tuition
          payments, and it does not independently verify or guarantee any
          tuition payment or the authenticity of uploaded payment evidence.
        </P>

        <Sub>Platform charges</Sub>

        <P>
          Tuition fees are separate from any charges for using {NAME} itself.
          Teachers may need a subscription plan to use the platform, and
          subscription charges are payable separately to {NAME}, as described
          in the Teacher Subscriptions and Billing section.
        </P>

        <P>
          Questions or disagreements about tuition fees should first be
          raised directly with the teacher. Our{" "}
          <PageLink href="/refund-policy">
            Refund &amp; Cancellation Policy
          </PageLink>{" "}
          explains how cancellations and refund requests are handled.
        </P>
      </>
    ),
  },

  {
    id: "teacher-subscriptions",
    title: "Teacher Subscriptions and Billing",
    content: (
      <>
        <Sub>Subscription charges</Sub>
        <P>
          Teachers pay subscription charges to {NAME} for access to the
          platform and its features. The price, billing period and features
          of a subscription are those of the plan the teacher subscribes to.
        </P>
        <P>
          Teacher subscription charges are separate from student tuition
          fees. Subscription charges are paid by teachers to {NAME}. Tuition
          fees are paid by students or their parents directly to their
          teachers, and {NAME} does not collect or refund them.
        </P>

        <Sub>Advance billing and renewal</Sub>
        <P>
          Subscription charges are billed in advance for each subscription
          period. Where a subscription renews automatically, the charge for
          the next period is also payable in advance.
        </P>

        <Sub>Cancelling automatic renewal</Sub>
        <P>
          Teachers can cancel automatic renewal at any time. After
          cancellation, access continues until the end of the subscription
          period already paid for, and the subscription is not renewed after
          that period ends.
        </P>

        <Sub>Subscription refunds</Sub>
        <List
          items={[
            "No partial refunds are provided for unused subscription periods, including when automatic renewal is cancelled before the end of a period.",
            "Duplicate subscription payments are eligible for a refund.",
            "Confirmed subscription billing errors are eligible for a refund.",
            "Other refund requests are reviewed individually, subject to applicable law.",
          ]}
        />
        <P>
          Our{" "}
          <PageLink href="/refund-policy">
            Refund &amp; Cancellation Policy
          </PageLink>{" "}
          explains how to request a subscription refund.
        </P>
      </>
    ),
  },

  {
    id: "payment-processing",
    title: "Third-Party Payment Processing",
    content: (
      <>
        <P>
          {NAME} does not currently offer online payment processing for
          student tuition fees and has no integrated payment gateway for them.
          Students pay tuition directly to their teacher, as described in the
          Tuition Fees and Payments section. If online tuition payments
          are introduced in the future, they will be handled through an
          appropriate payment provider, and we will update these Terms and
          our other applicable policies before that service becomes
          available.
        </P>

        <P>
          If a third-party payment provider is introduced, payments will be
          subject to that provider&rsquo;s applicable terms and privacy
          policy. Our <PageLink href="/privacy">Privacy Policy</PageLink>{" "}
          will explain what payment-related information, if any, we receive
          from the provider.
        </P>
      </>
    ),
  },

  {
    id: "cancellations",
    title: "Class Cancellation and Missed Classes",
    content: (
      <>
        <P>
          Teachers are responsible for conducting their scheduled classes
          and informing students in good time if a class is cancelled or
          rescheduled. Students are responsible for attending their classes
          and informing their teacher if they cannot attend.
        </P>

        <P>
          Teachers independently manage arrangements relating to cancelled
          or missed classes, including replacement classes, credits and
          tuition refunds. Further information is provided in our{" "}
          <PageLink href="/refund-policy">
            Refund &amp; Cancellation Policy
          </PageLink>.
        </P>
      </>
    ),
  },

  {
    id: "suspension-termination",
    title: "Account Suspension and Termination",
    content: (
      <>
        <P>We may restrict, suspend or close an account if, for example:</P>

        <List
          items={[
            "the account holder breaks these Terms or our other policies;",
            "the account is used for fraud, abuse or unauthorised access;",
            "this is necessary to protect students, teachers, other users or the platform; or",
            "the law requires it.",
          ]}
        />

        <P>
          Teachers can also deactivate student accounts in their classes
          and remove students from a class. Where possible, we will tell the
          account holder the reason for a restriction, unless doing so would
          be unsafe or unlawful.
        </P>

        <P>
          You can stop using the platform at any time. To close your account,
          contact your teacher (for student accounts) or contact us. What
          happens to your data afterwards is explained in our{" "}
          <PageLink href="/privacy">Privacy Policy</PageLink>.
        </P>
      </>
    ),
  },

  {
    id: "availability",
    title: "Platform Availability and Maintenance",
    content: (
      <>
        <P>
          We work to keep {NAME} available and reliable, but we cannot
          guarantee that it will always be available, uninterrupted or free
          of errors. The platform may be unavailable during maintenance,
          updates or technical problems, including problems with internet
          connections, devices or third-party services.
        </P>

        <P>
          Where possible, we will try to schedule maintenance outside common
          class times and to give notice of planned interruptions.
        </P>
      </>
    ),
  },

  {
    id: "liability",
    title: "Limitation of Liability",
    content: (
      <>
        <P>
          We are responsible for providing and maintaining the platform
          with reasonable care and skill. Teachers independently provide
          their educational services and manage their classes, students and
          tuition arrangements. We are not responsible for the content,
          quality or delivery of a teacher&rsquo;s classes, or for tuition
          payment arrangements between teachers and students, except to the
          extent that a matter arises from our own acts or omissions or
          where applicable law provides otherwise.
        </P>

        <P>
          To the extent permitted by applicable law, we are not liable for
          indirect or unforeseeable losses, or for losses caused by events
          outside our reasonable control, such as internet outages, device
          failures or interruptions to third-party services.
        </P>

        <Note>
          Nothing in these Terms limits or excludes any liability or any
          rights that cannot be limited or excluded under the law that
          applies to you.
        </Note>
      </>
    ),
  },

  // Only once a governing law is decided (LEGAL_BUSINESS_DETAILS.governingLaw,
  // currently the laws of Sri Lanka). Keep this wording in line with that value.
  ...(LEGAL_BUSINESS_DETAILS.governingLaw
    ? [
        {
          id: "governing-law",
          title: "Governing Law and Jurisdiction",
          content: (
            <P>
              These Terms and Conditions are governed by the laws of Sri Lanka.
              Any disputes arising in connection with these Terms shall be
              subject to the jurisdiction of the competent courts of Sri Lanka.
            </P>
          ),
        },
      ]
    : []),

  {
    id: "changes",
    title: "Changes to Terms",
    content: (
      <>
        <P>
          We may update these Terms when the platform, our services or the
          law change. The &ldquo;Last updated&rdquo; date at the top of this
          page shows when they were last changed.
        </P>

        <P>
          If we make important changes, we will tell users in advance
          through the platform or by email where possible. If you continue
          to use {NAME} after the changes take effect, you accept the
          updated Terms, to the extent permitted by applicable law. If you
          do not agree with them, you should stop using the platform.
        </P>
      </>
    ),
  },

  {
    id: "contact",
    title: "Contact Information",
    content: <ContactDetails topic="these Terms" />,
  },
];
