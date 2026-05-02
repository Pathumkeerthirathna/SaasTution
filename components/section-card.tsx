import { ReactNode } from "react";

type SectionCardProps = {
  title: string;
  description: string;
  children?: ReactNode;
};

export function SectionCard({ title, description, children }: SectionCardProps) {
  return (
    <article className="rounded-2xl border border-black/10 bg-card p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-white/10">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm text-muted">{description}</p>
      {children ? <div className="mt-4">{children}</div> : null}
    </article>
  );
}
