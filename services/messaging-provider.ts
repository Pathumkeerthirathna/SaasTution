type Recipient = {
  studentId: string;
  contact: string;
};

export type SendClassMessageInput = {
  classId: string;
  className: string;
  content: string;
  recipients: Recipient[];
};

export type RecipientDeliveryResult = {
  studentId: string;
  status: "SENT" | "FAILED";
  providerMessageId?: string;
  error?: string;
};

export type SendClassMessageResult = {
  provider: "mock" | "whatsapp";
  results: RecipientDeliveryResult[];
};

export interface MessagingProvider {
  sendClassMessage(input: SendClassMessageInput): Promise<SendClassMessageResult>;
}

class MockMessagingProvider implements MessagingProvider {
  async sendClassMessage(input: SendClassMessageInput): Promise<SendClassMessageResult> {
    const results = input.recipients.map((recipient) => {
      if (recipient.contact.trim().length === 0) {
        return {
          studentId: recipient.studentId,
          status: "FAILED" as const,
          error: "Missing contact information.",
        };
      }

      return {
        studentId: recipient.studentId,
        status: "SENT" as const,
        providerMessageId: `mock-${recipient.studentId}-${Date.now()}`,
      };
    });

    return {
      provider: "mock",
      results,
    };
  }
}

class WhatsAppMessagingProvider implements MessagingProvider {
  async sendClassMessage(input: SendClassMessageInput): Promise<SendClassMessageResult> {
    // Placeholder for future WhatsApp API integration.
    // Swap this implementation to call actual WhatsApp endpoints and map delivery statuses.
    // The returned providerMessageId should be used later by webhook updates.
    const results = input.recipients.map((recipient) => {
      if (recipient.contact.trim().length === 0) {
        return {
          studentId: recipient.studentId,
          status: "FAILED" as const,
          error: "Missing contact information.",
        };
      }

      return {
        studentId: recipient.studentId,
        status: "SENT" as const,
        providerMessageId: `wa-${recipient.studentId}-${Date.now()}`,
      };
    });

    return {
      provider: "whatsapp",
      results,
    };
  }
}

export function getMessagingProvider(): MessagingProvider {
  const provider = process.env.MESSAGE_PROVIDER?.trim().toLowerCase();

  if (provider === "whatsapp") {
    return new WhatsAppMessagingProvider();
  }

  return new MockMessagingProvider();
}
