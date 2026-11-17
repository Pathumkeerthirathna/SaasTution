
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
 * Privacy Policy (/privacy).
 *
 * This policy describes the information processed by SL Classroom to
 * provide its online education platform to independent teachers.
 *
 * The policy covers:
 * - Teacher, student and guardian account information.
 * - Class, attendance, assessment and payment records.
 * - Uploaded payment slips and other supporting documents.
 * - Student device approval and sign-in history.
 * - Email delivery records and security information.
 * - Live classroom participation and recordings.
 * - Optional teacher YouTube Live Streaming integration.
 * - Cookies, storage, retention and privacy requests.
 *
 * This document is a draft. See lib/legal/config.ts for outstanding
 * business and legal decisions.
 */

const NAME = LEGAL_PLATFORM.name;

export const privacyIntro = (
  <p>
    This Privacy Policy explains what personal information {NAME} collects,
    how it is used and shared, how long it is retained, and the choices you
    have. It applies to teachers, students, guardians and visitors to our
    public pages.
  </p>
);

export const privacySections: LegalSection[] = [
  {
    id: "introduction",
    title: "Introduction",
    content: (
      <>
        <P>
          {NAME} is an online education platform used by independent teachers
          to manage and conduct their classes and manage their students. To
          provide, maintain and protect the platform, we process personal
          information about teachers, students and guardians.
        </P>

        <P>
          In this policy, &ldquo;we&rdquo;, &ldquo;us&rdquo; and
          &ldquo;our&rdquo; mean the operator of {NAME}
          {LEGAL_BUSINESS_DETAILS.operatorName ? (
            <> ({LEGAL_BUSINESS_DETAILS.operatorName})</>
          ) : null}.
          Teachers independently manage their classes, decide which students
          they teach and maintain information about their students for
          educational and class-management purposes. We process relevant
          information to provide the platform and its features.
        </P>

        <P>
          This policy should be read together with our{" "}
          <PageLink href="/terms">Terms &amp; Conditions</PageLink> and{" "}
          <PageLink href="/refund-policy">
            Refund &amp; Cancellation Policy
          </PageLink>.
        </P>
      </>
    ),
  },

  {
    id: "information-we-collect",
    title: "Information We Collect",
    content: (
      <>
        <Sub>Teacher information</Sub>

        <List
          items={[
            "Account details: name, email address, contact number and password (stored only in hashed form).",
            "Public profile details the teacher chooses to add, such as a profile photo, biography, qualifications, achievements, subjects, teaching mediums, location (city and district), social media links and announcements.",
            "Classes, fees, schedules, calendar events and teaching materials.",
            "Subscription plan details and storage usage.",
            "If the teacher connects a YouTube channel: the channel's identifier and title, and a refresh token issued by Google for that channel, stored in encrypted form.",
            "If the teacher records a live session to their YouTube channel: the video's identifier and link, and its privacy and access settings.",
          ]}
        />

        <Sub>Student information</Sub>

        <List
          items={[
            "Account details: name, mobile number, parent or guardian mobile number, email address, grade, registration number and password (stored only in hashed form).",
            "Class enrolments, approval status and enrolment history.",
            "Attendance records, including QR code scans and changes made by teachers.",
            "Assignment, quiz, paper and breakout room submissions, answers and results.",
            "Monthly fee records, payment records, uploaded payment slips and payment messages. Uploaded payment slips and other payment evidence may contain personal and financial information, such as names, bank account details, amounts and transaction references. This information is processed to support payment record management and teacher review.",
          ]}
        />

        <Sub>Guardian information</Sub>

        <List
          items={[
            "Name, email address, phone number and password (stored only in hashed form), and the students linked to the guardian.",
          ]}
        />

        <Sub>Files and recordings</Sub>

        <List
          items={[
            "Files uploaded to the platform, such as notes, study materials, papers, submissions, payment slips and profile photos.",
            "Lecture recordings, including information such as their title, file size and length.",
          ]}
        />

        <Sub>Technical and security information</Sub>

        <List
          items={[
            "For students: information about each device used to sign in: a device identifier, a browser fingerprint and the browser characteristics used to create it (generated in the browser), the browser, operating system, device model and device name, and the device's most recent IP address.",
            "For students: the date of the first and most recent sign-in from each device, each device's approval status, any approval request message, and the teacher's decision, with its date and any reason given.",
            "Delivery records for the login details emails sent to students (welcome emails and credential-resend emails): the recipient's email address, delivery status, number of attempts, timestamps and any delivery error. Other emails sent by the platform are not included in these delivery records.",
            "Error reports containing technical details of the error, the page, and the browser, operating system and device type. These reports do not contain your IP address or account identifier.",
          ]}
        />

        <Note>
          The platform does not collect payment card numbers, card security
          codes or online banking login details as part of student tuition
          payment processing, because it does not currently provide an
          integrated online tuition payment gateway. Payment slips uploaded
          by users may nevertheless contain bank account details and
          transaction information.
        </Note>
      </>
    ),
  },

  {
    id: "how-we-use",
    title: "How We Use Information",
    content: (
      <>
        <P>
          We use personal information as necessary to provide, maintain,
          secure and support the platform, including to:
        </P>

        <List
          items={[
            "create and manage teacher, student and guardian accounts, and send login details and password reset emails;",
            "let teachers manage their classes, enrolments and student approvals;",
            "schedule classes and give students access to live classrooms;",
            "record and report attendance;",
            "deliver notes, assignments, quizzes, papers and recorded lectures, and collect student submissions;",
            "record monthly fees and let students submit, and teachers review and confirm, payment records;",
            "show guardians information about the students linked to them;",
            "secure accounts, including approving the devices students sign in from and limiting repeated attempts;",
            "provide support and respond to requests;",
            "manage teacher subscription plans and related platform services; and",
            "identify and fix errors, and maintain and improve the platform.",
          ]}
        />

        <P>
          We do not sell personal information, and we do not use personal
          information for advertising.
        </P>
      </>
    ),
  },

  {
    id: "how-we-share",
    title: "How Information Is Shared",
    content: (
      <>
        <P>
          Information is made available according to each user&rsquo;s account,
          permissions and role on the platform:
        </P>

        <List
          items={[
            "Teachers can see information about students in their own classes, including relevant contact details, enrolments, attendance, submissions, results, fees, payment records and device information.",
            "Students can see their own information and information their teachers share with their class, such as schedules, materials and recordings. In live classes and breakout rooms, other participants may see your name and anything you choose to share, such as your video, audio, messages or whiteboard input.",
            "Guardians can see information about the students linked to their account, such as attendance and quiz results.",
            "Authorised administrators can use the platform's administration features where necessary to manage teacher accounts and subscriptions. Authorised operators with access to the platform's servers may access information where necessary for support, security and legal obligations.",
            "Visitors to the public site can see teacher profiles and public class pages that teachers choose to make available.",
          ]}
        />

        <P>
          We may also share information with service providers that help us
          operate the platform, as described in the Third-Party Services
          section. We may disclose information where required by law, where
          necessary to protect the safety of users, or to investigate and
          address misuse of the platform.
        </P>
      </>
    ),
  },

  {
    id: "third-party-services",
    title: "Third-Party Services",
    content: (
      <>
        <P>
          We use service providers and supporting services to operate
          { " "}{NAME}. These services may receive information necessary to
          perform their respective functions.
        </P>

        <List
          items={[
            <>
              <strong>Hosting and infrastructure:</strong> The platform,
              its database and uploaded files are hosted on servers provided
              by a hosting provider. Information required to operate the
              platform is processed through this infrastructure.
            </>,
            <>
              <strong>Email delivery:</strong> Emails sent by the platform,
              such as login details, password resets, email verification
              codes, device approval notifications, class announcements and
              live session notices, are sent through an email delivery service
              using SMTP. The service receives the recipient&rsquo;s email
              address and the content necessary to send the email.
            </>,
            <>
              <strong>Online classroom services:</strong> {NAME} provides
              online classroom functionality that enables teachers and
              students to participate in live classes through the platform.
              When a teacher records a live session, the recording is saved to
              the teacher&rsquo;s own YouTube channel, not to {NAME}&rsquo;s file
              storage. Recordings stored on {NAME} itself are recordings that
              teachers upload.
            </>,
            <>
              <strong>YouTube Live Streaming:</strong> Teachers may connect
              their own YouTube channels and use YouTube Live Streaming to
              broadcast and record classes through YouTube. When this feature
              is used, information shared during the livestream may be
              processed by Google and YouTube under their applicable terms and
              privacy policies. Teachers are responsible for managing their
              YouTube accounts, livestream settings and audience access. To
              connect a channel, the teacher authorises {NAME} through Google,
              and we store an encrypted refresh token for that channel.
              Teachers can revoke this access at any time through their Google
              account, and can contact us to request deletion of the stored
              connection.
            </>,
            <>
              <strong>Whiteboard fonts:</strong> The classroom whiteboard
              may load font files from a public content delivery network
              (esm.sh), which may receive standard request information such
              as your IP address.
            </>,
          ]}
        />

        <P>
          Device identification and QR code scanning tools run within your
          browser. We do not use third-party analytics, advertising or social
          media tracking services.
        </P>

        <P>
          Third-party services may process information under their own
          applicable terms and privacy policies. Their handling of information
          is governed by those policies in addition to the information
          described here.
        </P>
      </>
    ),
  },

  {
    id: "payment-information",
    title: "Payment Information",
    content: (
      <>
        <P>
          {NAME} does not currently provide an integrated online payment
          gateway for student tuition fees. Students or their parents pay
          tuition fees directly to the respective teacher using a payment
          method accepted by that teacher.
        </P>

        <P>
          For payment record management, the platform may store:
        </P>

        <List
          items={[
            "each student's monthly fee records, including discounts or waivers applied by the teacher;",
            "payment records submitted by students, including the amount, an optional note and any uploaded payment slip or supporting evidence; and",
            "the teacher's confirmation or feedback, and messages exchanged about the payment.",
          ]}
        />

        <P>
          Uploaded payment slips may contain personal or financial
          information, including names, bank account details, payment amounts
          and transaction references. Through the platform, payment slips are
          available to the relevant student and their teacher. The platform
          has no administrator feature for viewing payment slips; authorised
          operators with access to the platform&rsquo;s servers may access
          this information where necessary for support or security.
        </P>

        <P>
          Please do not upload documents containing full card numbers, card
          security codes, online banking passwords or other sensitive login
          credentials.
        </P>

        <P>
          If integrated online tuition payments are introduced through a
          third-party payment provider in the future, that provider may
          process payment information under its own terms and privacy policy.
          We will update this policy to explain what payment information, if
          any, we receive before the service becomes available.
        </P>
      </>
    ),
  },

  {
    id: "live-recordings",
    title: "Live Classroom and Recording Data",
    content: (
      <>
        <Sub>Taking part in a live class</Sub>

        <P>
          Your browser may ask for permission to use your camera and
          microphone when you participate in a live class. You decide whether
          to allow this access. You can manage your camera and microphone
          settings during a session, subject to the activities and
          requirements established by your teacher.
        </P>

        <P>
          Your name, video, audio, screen sharing, messages and whiteboard
          input may be shared with other participants in the live session.
          When you join a live session, information about your participation
          and joining time may be recorded and used for attendance purposes.
        </P>

        <Sub>Recordings</Sub>

        <P>
          Teachers can record a live session. Recording a live session saves
          it to the teacher&rsquo;s own YouTube channel; it is not stored in
          { " "}{NAME}&rsquo;s file storage. {NAME} keeps the video&rsquo;s
          identifier and link so that the teacher can make the recording
          available to their class.
        </P>

        <P>
          Teachers can also upload lecture recordings to {NAME}. Uploaded
          recordings are the recordings stored directly on the platform. A
          recording may include the names, video, audio and messages of
          participants who took part. The teacher decides who can access each
          recording, for example only students enrolled in the relevant class.
        </P>

        <P>
          Teachers are responsible for informing participants when a session
          is recorded and ensuring that any necessary permissions or consent
          are obtained.
        </P>

        <P>
          Teachers may also use their own connected YouTube channels to
          livestream classes. When a class is broadcast through YouTube,
          information shared during the broadcast may be processed by Google
          and YouTube under their applicable privacy policies. Teachers are
          responsible for managing their YouTube livestreams and any
          associated content on their own channels.
        </P>

        <P>
          Students must not independently record classes or share recordings
          unless the teacher permits it. When a teacher deletes an uploaded
          recording, it is removed from view immediately; its file is
          permanently deleted later by the platform&rsquo;s maintenance
          process, and a record with details such as its title, size and
          length remains. Recordings on a teacher&rsquo;s YouTube channel are
          managed by the teacher through YouTube.
        </P>
      </>
    ),
  },

  {
    id: "cookies",
    title: "Cookies and Similar Technologies",
    content: (
      <>
        <P>
          {NAME} uses cookies and browser storage needed for the platform to
          operate and provide its features:
        </P>

        <List
          items={[
            "Sign-in cookies, which keep you signed in to your teacher, student, administrator or guardian account. These cookies cannot be read by ordinary scripts running on the page and expire after a limited period or when you sign out.",
            "A short-lived security cookie used while a teacher connects a YouTube channel.",
            "Browser storage (local storage) for interface preferences, such as classroom layout, dismissed hints and which messages you have already seen.",
          ]}
        />

        <P>
          We do not use analytics, advertising or tracking cookies. If you
          block essential cookies, you may not be able to sign in or use
          certain platform features.
        </P>
      </>
    ),
  },

  {
    id: "security",
    title: "Data Storage and Security",
    content: (
      <>
        <P>
          We take reasonable technical and organisational measures to protect
          personal information against unauthorised access, loss, misuse or
          disclosure. These measures include:
        </P>

        <List
          items={[
            "storing passwords only in hashed form;",
            "encrypting the refresh tokens of connected YouTube channels, and the contents of queued login emails, which are cleared once the email provider accepts the email or when they expire;",
            "limiting access to information according to user roles, account permissions and class relationships;",
            "approving the devices students sign in from and limiting repeated sign-in, registration and password reset attempts;",
            "using single-use, time-limited links and codes for password resets and email confirmation; and",
            "keeping error logs free of IP addresses and account identifiers.",
          ]}
        />

        <P>
          No system is completely secure, and we cannot guarantee the
          security of information transmitted over the internet. You can
          help protect your account by using a strong password, keeping it
          private and signing out when using shared devices.
        </P>
      </>
    ),
  },

  {
    id: "retention",
    title: "Data Retention and Deletion",
    content: (
      <>
        <P>
          We retain personal information for as long as it is needed to
          provide and operate the platform, support teachers and students,
          maintain relevant records, meet applicable legal obligations and
          resolve disputes.
        </P>

        <P>
          Different types of information may be retained for different
          periods depending on their purpose and how they are used.
        </P>

        <List
          items={[
            "Most deletions in the platform only hide a record; they do not erase it or its files. For example, when a teacher deletes or deactivates a student, removes a student from a class, or deletes a class paper or material bundle, the record is hidden and kept, together with associated uploaded files such as paper files, student paper submissions and bundle files. This keeps class, fee and attendance histories consistent.",
            "Payment records and uploaded payment slips are kept. A payment slip is deleted only when it is replaced by a new upload.",
            "Notes and assignments are deleted permanently: when a teacher deletes one, its record and its stored files, including every student submission for an assignment, are deleted. Exceptions: files uploaded before the platform's current file storage system was introduced may remain on the server after their records are deleted, and notes and assignments deleted under an earlier version of the platform remain hidden rather than erased.",
            "When a teacher deletes an uploaded recording, it is removed from view immediately. Its file is permanently deleted later by the platform's maintenance process, and a record with details such as its title, size and length remains.",
            "When a teacher removes a student's device, that device's stored information is deleted.",
            "Error logs are kept in files of limited size, so older entries are deleted automatically as new entries are written.",
            "The encrypted content of queued login emails is cleared once the email provider accepts the email, or when it expires. The delivery records themselves are kept.",
          ]}
        />

        <P>
          We are establishing appropriate retention periods for different
          categories of information. Where a fixed retention period has not
          been established, information is retained according to its purpose
          and applicable requirements.
        </P>

        <P>
          If you would like information corrected or deleted, you can contact
          us as described in the User Privacy Requests section. Some
          information may need to be retained for legitimate operational,
          legal or record-keeping purposes.
        </P>
      </>
    ),
  },

  {
    id: "privacy-requests",
    title: "User Privacy Requests",
    content: (
      <>
        <P>
          Subject to applicable law and any relevant limitations, you can
          contact us to request that we:
        </P>

        <List
          items={[
            "tell you what personal information we hold about you and provide access to it;",
            "correct information that is inaccurate or incomplete; and",
            "delete your personal information or close your account where appropriate.",
          ]}
        />

        <P>
          Many details can be corrected directly. Teachers can update their
          own profiles and relevant student details. Students can ask their
          teacher to correct information maintained through their class.
          For other requests, contact us using the contact details associated
          with your account. We may need to verify your identity before
          acting on a request.
        </P>

        <P>
          The platform does not offer automatic or self-service account
          deletion. Deletion requests are handled manually by the operator
          and may require removing database records and the files associated
          with them, such as uploaded documents and recordings.
        </P>

        <P>
          Some information may need to be retained even after a request, for
          example where a teacher needs relevant fee or attendance records,
          where the law requires retention, or where information is needed
          to resolve a dispute. If information cannot be deleted, we will
          explain the reason where appropriate.
        </P>

        <P>
          Requests concerning a student&rsquo;s information may also involve the
          student&rsquo;s teacher or parent or guardian, depending on the
          circumstances and applicable requirements.
        </P>
      </>
    ),
  },

  {
    id: "children",
    title: "Children's Privacy",
    content: (
      <>
        <P>
          Many students using {NAME} may be children. We process information
          about students to provide class management, learning and related
          platform features. We do not use student information for
          advertising or sell it.
        </P>

        <P>
          Parents and guardians should supervise their child&rsquo;s use of the
          platform and review whether the child should register and
          participate. Teachers who teach children are responsible for
          handling student information appropriately and ensuring that
          classroom activities and recordings are suitable for their
          students.
        </P>

        <P>
          Guardians may follow a student&rsquo;s progress through the guardian
          portal when a teacher links them to that student. A parent or
          guardian who has a question or concern about a child&rsquo;s information,
          or wants it corrected or deleted, may contact the child&rsquo;s teacher
          or us.
        </P>
      </>
    ),
  },

  {
    id: "updates",
    title: "Policy Updates",
    content: (
      <>
        <P>
          We may update this Privacy Policy when the platform, our services,
          service providers or applicable laws change. The
          &ldquo;Last updated&rdquo; date at the top of this page shows when
          the policy was last revised.
        </P>

        <P>
          If we make important changes, particularly changes to how
          personal information is collected, used or shared, we will try to
          notify users through the platform or by email before those changes
          take effect.
        </P>
      </>
    ),
  },

  {
    id: "contact",
    title: "Contact Information",
    content: (
      <ContactDetails topic="this Privacy Policy or your personal information" />
    ),
  },
];
