"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useState } from "react";
import { Lock, Mail, Phone, UserPlus, UserRound } from "lucide-react";

import { AuthShell } from "@/components/auth-shell";
import { AuthIllustration } from "@/components/auth-illustration";

type RegisterFormState = {
  name: string;
  email: string;
  password: string;
  contact: string;
};

type FieldErrors = Partial<Record<keyof RegisterFormState, string>>;

const FIELD_LABELS: Record<keyof RegisterFormState, string> = {
  name: "Full name",
  email: "Email address",
  contact: "Phone number",
  password: "Password",
};

function baseInputClass(hasError: boolean) {
  return `w-full rounded-lg border bg-white py-2.5 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 ${
    hasError
      ? "border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100"
      : "border-slate-200 focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100"
  }`;
}

const LABEL_CLASS =
  "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500";

const ICON_CLASS =
  "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400";

export default function RegisterPage() {
  const router = useRouter();
  const [formState, setFormState] = useState<RegisterFormState>({
    name: "",
    email: "",
    password: "",
    contact: "",
  });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  function updateField(field: keyof RegisterFormState, value: string) {
    setFormState((prev) => ({ ...prev, [field]: value }));

    setFieldErrors((prev) => {
      if (!prev[field]) return prev;

      const next = { ...prev };
      const error =
        field === "password"
          ? validatePassword(value)
          : value.trim()
          ? undefined
          : next[field];

      if (error) {
        next[field] = error;
      } else {
        delete next[field];
      }

      return next;
    });
  }

  function validatePassword(password: string): string | undefined {
    if (!password.trim()) {
      return `${FIELD_LABELS.password} is required.`;
    }

    const missing: string[] = [];

    if (password.length < 8) missing.push("be at least 8 characters long");
    if (!/[A-Z]/.test(password)) missing.push("include an uppercase letter");
    if (!/[a-z]/.test(password)) missing.push("include a lowercase letter");
    if (!/[0-9]/.test(password)) missing.push("include a number");

    return missing.length > 0
      ? `Password must ${missing.join(", ")}.`
      : undefined;
  }

  function validate(state: RegisterFormState): FieldErrors {
    const errors: FieldErrors = {};

    (["name", "email", "contact"] as const).forEach((field) => {
      if (!state[field].trim()) {
        errors[field] = `${FIELD_LABELS[field]} is required.`;
      }
    });

    const passwordError = validatePassword(state.password);
    if (passwordError) {
      errors.password = passwordError;
    }

    return errors;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    const errors = validate(formState);

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(formState),
      });

      const payload = (await response.json()) as {
        success: boolean;
        error?: { message?: string };
      };

      if (!response.ok || !payload.success) {
        setErrorMessage(payload.error?.message ?? "Unable to register. Please try again.");
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch {
      setErrorMessage("Unable to register right now. Please try again in a moment.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Create teacher account"
      subtitle="Register securely to manage classes, lectures and student updates."
      footerText="Already have an account?"
      footerLinkHref="/login"
      footerLinkLabel="Sign in"
      icon={<UserPlus className="h-5 w-5" />}
      illustration={<AuthIllustration />}
      showBackToHome
    >
      <form className="space-y-3.5" onSubmit={handleSubmit} noValidate>
        <div>
          <label htmlFor="name" className={LABEL_CLASS}>
            Full name
          </label>
          <div className="relative">
            <UserRound className={ICON_CLASS} />
            <input
              id="name"
              type="text"
              autoComplete="name"
              value={formState.name}
              onChange={(event) => updateField("name", event.target.value)}
              className={baseInputClass(Boolean(fieldErrors.name))}
              placeholder="Enter your full name"
            />
          </div>
          {fieldErrors.name ? (
            <p className="mt-1 text-[11px] text-red-600">{fieldErrors.name}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="email" className={LABEL_CLASS}>
            Email address
          </label>
          <div className="relative">
            <Mail className={ICON_CLASS} />
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={formState.email}
              onChange={(event) => updateField("email", event.target.value)}
              className={baseInputClass(Boolean(fieldErrors.email))}
              placeholder="teacher@school.com"
            />
          </div>
          {fieldErrors.email ? (
            <p className="mt-1 text-[11px] text-red-600">{fieldErrors.email}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="contact" className={LABEL_CLASS}>
            Phone number
          </label>
          <div className="relative">
            <Phone className={ICON_CLASS} />
            <input
              id="contact"
              type="tel"
              autoComplete="tel"
              value={formState.contact}
              onChange={(event) => updateField("contact", event.target.value)}
              className={baseInputClass(Boolean(fieldErrors.contact))}
              placeholder="07X XXX XXXX"
            />
          </div>
          {fieldErrors.contact ? (
            <p className="mt-1 text-[11px] text-red-600">{fieldErrors.contact}</p>
          ) : null}
        </div>

        <div>
          <label htmlFor="password" className={LABEL_CLASS}>
            Password
          </label>
          <div className="relative">
            <Lock className={ICON_CLASS} />
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              value={formState.password}
              onChange={(event) => updateField("password", event.target.value)}
              className={baseInputClass(Boolean(fieldErrors.password))}
              placeholder="At least 8 characters"
            />
          </div>
          {fieldErrors.password ? (
            <p className="mt-1 text-[11px] text-red-600">{fieldErrors.password}</p>
          ) : null}
        </div>

        {errorMessage ? (
          <p className="whitespace-pre-line rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
            {errorMessage}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus:ring-2 focus:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <UserPlus className="h-4 w-4" />
          {isSubmitting ? "Creating account..." : "Create account"}
        </button>

        <p className="text-center text-[11px] leading-4 text-slate-400">
          By registering, you agree to the platform security policy and safe data
          handling rules.
        </p>
      </form>
    </AuthShell>
  );
}
