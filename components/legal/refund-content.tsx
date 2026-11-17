
import {
  ContactDetails,
  ContactEmail,
  List,
  Note,
  P,
  PageLink,
  Sub,
  type LegalSection,
} from "@/components/legal/LegalPage";
import { LEGAL_PLATFORM, LEGAL_REFUND_RULES } from "@/lib/legal/config";

/*
 * Refund & Cancellation Policy (/refund-policy).
 *
 * This policy reflects the current SL Classroom payment model:
 * - Teachers independently operate their classes and set their fees.
 * - Students pay tuition fees directly to their teachers.
 * - Students can submit payment records and slips through the platform.
 * - Teachers independently review and confirm submitted payment records.
 * - SL Classroom does not collect, hold, process or distribute tuition fees.
 * - Teachers independently manage tuition cancellations, refunds,
 *   credits and replacement classes.
 *
 * Teacher subscription fees are separate from student tuition fees.
 *
 * Notice periods and refund request windows are configurable through
 * LEGAL_REFUND_RULES. When unset, the teacher's own terms apply.
 */

const NAME = LEGAL_PLATFORM.name;

const {
  studentCancellationNotice,
  teacherCancellationNotice,
  refundRequestWindow,
} = LEGAL_REFUND_RULES;

export const refundIntro = (
  <p>
    This policy explains how class cancellations, missed classes and refund
    requests are handled on {NAME}. Teachers independently operate their
    classes and are responsible for managing tuition payments, cancellations,
    replacement classes, credits and refunds. {NAME} provides the technology
    platform and related payment-record management features but does not
    handle tuition payments or issue tuition refunds on behalf of teachers.
  </p>
);

export const refundSections: LegalSection[] = [
  {
    id: "introduction",
    title: "Introduction",
    content: (
      <>
        <P>
          This policy applies to tuition fees for classes that teachers run on
          { " "}{NAME}, and to cancellations of those classes. It should be
          read with our <PageLink href="/terms">Terms &amp; Conditions</PageLink>.
        </P>
        <P>
          Charges that teachers pay for their own {NAME} subscription plan
          are separate from student tuition fees. They are covered only by
          the Teacher Subscription Refunds section of this policy; the other
          sections apply to student tuition fees.
        </P>
      </>
    ),
  },

  {
    id: "payment-relationship",
    title: "Nature of the Payment Relationship",
    content: (
      <>
        <List
          items={[
            "Teachers are independent education providers. Each teacher independently decides what to charge for their classes and the payment arrangements offered to their students.",
            "Students or their parents pay tuition fees directly to the respective teacher, monthly for a class or, where the teacher offers it, per class.",
            `${NAME} provides the technology platform, including features that allow teachers to record student fees and students to submit payment records and supporting evidence for teacher review.`,
            `At present, ${NAME} does not process online payments and does not receive or hold tuition fees: it does not provide an integrated online payment gateway for student tuition fees and does not collect those tuition payments. Students make payments directly to their teachers using payment methods specified or accepted by the respective teachers.`,
            "Teachers are independently responsible for reviewing payment evidence, confirming payments, managing tuition refunds and communicating payment arrangements with their students.",
          ]}
        />
        <Note>
          Because tuition fees are paid directly to teachers, teachers are
          responsible for handling and issuing any agreed tuition refunds.
          { " "}{NAME} cannot itself refund, reverse or withhold a payment made to a
          teacher, and does not collect, hold or transfer tuition payments on
          behalf of teachers. If integrated online tuition
          payments are introduced in the future, this policy will be updated
          to explain the applicable payment and refund arrangements.
        </Note>
      </>
    ),
  },

  {
    id: "monthly-payments",
    title: "Monthly Tuition Payments",
    content: (
      <>
        <P>
          For monthly classes, the platform records a fee for each enrolled
          student for each month. The teacher may apply a discount, waiver or
          other adjustment, for example when a student joins part-way through
          a month. The amount due is shown in the student portal.
        </P>

        <P>
          A monthly payment may need to be reviewed by the teacher for a
          refund, credit or adjustment if, for example:
        </P>

        <List
          items={[
            "the teacher cancelled classes during the month and did not provide replacement classes;",
            "the student paid for a month but was removed from the class, or the class ended early;",
            "the student paid more than the amount due, or paid twice for the same month; or",
            "the payment was made for the wrong class or the wrong month.",
          ]}
        />

        <P>
          A monthly fee is not automatically refunded in any of these cases.
          The teacher independently reviews the circumstances and determines
          the appropriate arrangement in accordance with their stated terms
          and applicable law.
        </P>
      </>
    ),
  },

  {
    id: "per-class-payments",
    title: "Per-Class Tuition Payments",
    content: (
      <>
        <P>
          Some teachers may agree a fee per class instead of a monthly fee.
          A per-class payment relates to a specific scheduled class. If that
          class does not take place, the student and teacher should agree
          whether the payment is carried forward to another class, credited
          or refunded.
        </P>

        <P>
          The platform currently records fees per month. Per-class payment
          arrangements are made directly between the teacher and the student,
          and the teacher&rsquo;s own terms and applicable law apply to those
          arrangements.
        </P>
      </>
    ),
  },

  {
    id: "student-cancellations",
    title: "Student-Initiated Cancellations",
    content: (
      <>
        <P>
          A student who wants to stop attending a class, or cannot attend a
          scheduled class, should inform their teacher as early as possible
          {studentCancellationNotice ? (
            <> and at least {studentCancellationNotice}</>
          ) : (
            <>
              , within any notice period the teacher has set or
              communicated
            </>
          )}
          .
        </P>

        <P>
          Leaving a class or cancelling attendance does not by itself
          automatically entitle a student to a refund for a period already
          paid. Whether any part of the fee is refunded, credited or carried
          forward is handled directly between the teacher and the student,
          taking into account the teacher&rsquo;s terms, the circumstances and
          applicable law.
        </P>
      </>
    ),
  },

  {
    id: "teacher-cancellations",
    title: "Teacher-Initiated Cancellations",
    content: (
      <>
        <P>
          When a teacher cancels a scheduled class, they should inform their
          students as early as possible
          {teacherCancellationNotice ? (
            <> and at least {teacherCancellationNotice}</>
          ) : null}
          {" "}and explain whether the class will be rescheduled or whether
          another arrangement will be offered.
        </P>

        <P>
          When a teacher cancels a paid class, the teacher is responsible for
          arranging an appropriate outcome with the affected students. This
          may include providing a replacement class, offering a credit or
          issuing an appropriate refund, taking into account the teacher&rsquo;s
          stated terms, the circumstances and applicable law.
        </P>

        <P>
          Teachers are responsible for communicating these arrangements
          directly to their students and updating relevant class and payment
          records on the platform where applicable.
        </P>

        <P>
          Repeated cancellations or failure to honour class arrangements may
          be addressed under our{" "}
          <PageLink href="/terms">Terms &amp; Conditions</PageLink>.
        </P>
      </>
    ),
  },

  {
    id: "teacher-absence",
    title: "Teacher Absence or Missed Classes",
    content: (
      <>
        <P>
          If a teacher does not attend a scheduled class without providing
          notice, the following steps are recommended:
        </P>

        <List
          items={[
            "The student should first contact the teacher directly to clarify what happened.",
            "The teacher should communicate an appropriate arrangement, such as a replacement class, credit or refund, taking into account the applicable terms and circumstances.",
            `If the issue cannot be resolved directly, the student may contact ${NAME}. We may review relevant class schedules and payment records available on the platform and contact the teacher to assist with communication.`,
          ]}
        />

        <P>
          The teacher remains responsible for resolving the tuition
          arrangement and issuing any agreed refund or credit. {NAME} does
          not independently decide or issue tuition refunds.
        </P>
      </>
    ),
  },

  {
    id: "student-absence",
    title: "Student Absence or Missed Classes",
    content: (
      <>
        <P>
          If a class takes place as scheduled and a student does not attend,
          the fee for that class or month is normally still payable, subject
          to the teacher&rsquo;s stated terms and applicable law. Where the teacher
          records the class, the student may be able to watch the recording
          if the teacher makes it available.
        </P>

        <P>
          Whether a missed class is replaced, credited or refunded is handled
          directly between the teacher and the student. The teacher may
          consider the circumstances, such as illness or another serious
          reason, when deciding what arrangement is appropriate.
        </P>
      </>
    ),
  },

  {
    id: "rescheduled-classes",
    title: "Rescheduled Classes",
    content: (
      <>
        <P>
          Teachers and students can agree to move a class to another time.
          The teacher is responsible for communicating the revised
          arrangement and updating the schedule on the platform so that
          students can see the new time. A class that takes place at the
          agreed rescheduled time is treated as held.
        </P>

        <P>
          If a student cannot attend the new time, they should inform the
          teacher. Any alternative arrangement, such as access to a recording,
          another replacement class, a credit or a refund, should be agreed
          directly with the teacher.
        </P>
      </>
    ),
  },

  {
    id: "eligibility",
    title: "Refund Eligibility and Assessment",
    content: (
      <>
        <P>
          Teachers are responsible for reviewing tuition refund requests
          relating to their own classes. Depending on the circumstances,
          the following matters may be considered:
        </P>

        <List
          items={[
            <>
              <strong>Teacher-related issues:</strong> classes cancelled or
              not held by the teacher, or classes that were substantially
              different from what was advertised.
            </>,
            <>
              <strong>Student-related cancellations:</strong> the notice
              provided by the student, classes already held during the
              relevant period, and the teacher&rsquo;s own terms.
            </>,
            <>
              <strong>Technical issues:</strong> whether a technical problem
              with the platform prevented the student from joining and
              whether the class was recorded or replaced. Problems with the
              student&rsquo;s own device or internet connection are generally not
              automatically grounds for a refund.
            </>,
            <>
              <strong>Duplicate payments:</strong> the same tuition fee paid
              more than once.
            </>,
            <>
              <strong>Incorrect amounts:</strong> a payment higher than the
              amount due or a fee recorded incorrectly.
            </>,
            <>
              <strong>Payment arrangements:</strong> payments made for the
              wrong teacher, class or month, or errors involving a bank or
              payment service.
            </>,
          ]}
        />

        <P>
          Once confirmed, duplicate payments and overpayments should be
          addressed by the teacher through an appropriate refund, credit or
          adjustment. Other requests are assessed individually by the
          teacher, in accordance with the teacher&rsquo;s terms and applicable law.
        </P>

        <P>
          Nothing in this policy creates an automatic right to a refund in
          every circumstance, and nothing in it limits any rights you may
          have under applicable law.
        </P>
      </>
    ),
  },

  {
    id: "request-procedure",
    title: "Refund Request Procedure",
    content: (
      <>
        <Sub>1. Contact your teacher</Sub>

        <P>
          Since tuition fees are paid directly to teachers, students or
          parents should first send refund requests to the respective teacher.
          Explain the reason for the request, the class and month concerned,
          the amount paid and the payment method used
          {refundRequestWindow ? (
            <> within {refundRequestWindow}</>
          ) : null}
          .
        </P>

        <Sub>2. Contact us if platform-related assistance is needed</Sub>

        <P>
          If you cannot resolve a matter with the teacher, or need assistance
          concerning payment records or other information available through
          the platform, you may contact us at <ContactEmail />.
        </P>

        <P>
          To help us review the relevant platform records, please include:
        </P>

        <List
          items={[
            "your name and the email address associated with your account;",
            "your registration number, the teacher and the class;",
            "the payment date, amount and month, together with the payment slip or reference, if available; and",
            "a brief explanation of the issue and any relevant communication with the teacher.",
          ]}
        />

        <P>
          We may review information available on the platform, such as fee
          records, submitted payment records, class schedules and attendance,
          and may contact the teacher to assist with communication.
        </P>

        <P>
          Contacting {NAME} does not mean that we will decide or issue a
          tuition refund. The teacher remains responsible for handling the
          tuition payment arrangement and any agreed refund.
        </P>
      </>
    ),
  },

  {
    id: "disputes",
    title: "Payment Disputes",
    content: (
      <>
        <P>
          If a payment record you submitted has not been confirmed, or the
          teacher has requested clarification, you may reply through the
          payment&rsquo;s message thread on the platform. You should also contact
          the teacher directly to clarify the payment.
        </P>

        <P>
          {NAME} may assist by reviewing relevant records available on the
          platform and contacting the teacher where appropriate. However,
          we do not receive or hold tuition fees and cannot reverse a bank
          transfer, independently verify a bank transaction or issue a
          tuition refund on the teacher&rsquo;s behalf.
        </P>

        <P>
          For issues involving the actual payment transaction, such as a
          transfer that did not reach the intended recipient, you may also
          need to contact your bank or the payment service you used.
        </P>

        <P>
          If a teacher repeatedly fails to honour their responsibilities or
          resolve valid issues, we may take appropriate platform-level action
          under our <PageLink href="/terms">Terms &amp; Conditions</PageLink>.
          Any such action is separate from the teacher&rsquo;s responsibility to
          resolve the tuition payment or refund.
        </P>
      </>
    ),
  },

  {
    id: "gateway-fees",
    title: "Payment Gateway Fees",
    content: (
      <>
        <P>
          Students may use payment methods made available or accepted by
          their teachers. Banks and payment services may charge fees for
          making or refunding a payment. These fees are set by the relevant
          bank or payment service under its own terms, and they may not be
          returned when a payment is refunded.
        </P>

        <P>
          If {NAME} introduces integrated online tuition payments through
          a payment provider in the future, this policy will be updated to
          explain how that provider&rsquo;s fees and refund arrangements apply.
        </P>
      </>
    ),
  },

  {
    id: "processing",
    title: "Refund Processing",
    content: (
      <>
        <P>
          Any approved tuition refund is arranged and paid directly by the
          teacher to the student or parent. The teacher and student may agree
          to use the original payment method or another suitable method.
          The time required for a refund depends on the teacher and, where
          applicable, the bank or payment service involved.
        </P>

        <P>
          Once a refund, credit or adjustment is agreed, the teacher is
          responsible for ensuring that the relevant fee and payment records
          on the platform are updated to reflect the arrangement.
        </P>

        <P>
          {NAME} does not process or control the timing of tuition refunds
          because tuition payments are made directly to teachers.
        </P>
      </>
    ),
  },

  {
    id: "teacher-subscription-refunds",
    title: "Teacher Subscription Refunds",
    content: (
      <>
        <P>
          This section applies only to the subscription charges that teachers
          pay to {NAME} for using the platform. It does not apply to student
          tuition fees. Tuition fees are paid directly to teachers, and
          tuition cancellations and refunds remain the responsibility of the
          teacher, as described in the other sections of this policy.
          { " "}{NAME} does not collect or refund student tuition fees.
        </P>

        <Sub>Cancellation</Sub>
        <List
          items={[
            "Subscription charges are billed in advance for each subscription period.",
            "Teachers can cancel automatic renewal at any time.",
            "After cancellation, access continues until the end of the subscription period already paid for.",
          ]}
        />

        <Sub>Refunds</Sub>
        <List
          items={[
            "No partial refunds are provided for unused subscription periods.",
            "Duplicate subscription payments are eligible for a refund.",
            "Confirmed subscription billing errors are eligible for a refund.",
            "Other refund requests are reviewed individually, subject to applicable law.",
          ]}
        />

        <Sub>Requesting a subscription refund</Sub>
        <P>
          To cancel automatic renewal or request a subscription refund, please
          contact us at <ContactEmail />, including the email address of your
          teacher account, the subscription plan, and the date, amount and any
          reference of the payment concerned. The method and timing of an
          approved subscription refund depend on how the subscription was
          paid.
        </P>
      </>
    ),
  },

  {
    id: "contact",
    title: "Contact Information",
    content: (
      <ContactDetails topic="this policy, a cancellation or a platform-related refund enquiry" />
    ),
  },
];
