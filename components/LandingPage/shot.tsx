import { SampleTag } from "./ui";

type ShotProps = {
  /** File name without extension, in /public/landing (desktop image, 16:10). */
  name: string;
  alt: string;
  /** A phone-layout capture called `<name>-m.webp` (390x844). */
  mobile?: boolean;
  priority?: boolean;
  /** Desktop-only screenshot: on phones it scrolls sideways inside its frame instead of shrinking. */
  scrollOnMobile?: boolean;
  className?: string;
  tag?: boolean;
};

/**
 * A real product screenshot. Below the fold it lazy-loads; width/height (or aspect-ratio for
 * the phone variant) are set so nothing shifts while it loads.
 */
export default function Shot({
  name,
  alt,
  mobile = false,
  priority = false,
  scrollOnMobile = false,
  className = "",
  tag = true,
}: ShotProps) {
  const src = `/landing/${name}.webp`;

  const image = (
    <picture>
      {mobile ? <source media="(max-width: 639px)" srcSet={`/landing/${name}-m.webp`} /> : null}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        width={1440}
        height={900}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        {...(priority ? { fetchPriority: "high" as const } : {})}
        className={`block h-auto w-full ${mobile ? "max-sm:aspect-[390/844] max-sm:object-cover max-sm:object-top" : ""}`}
      />
    </picture>
  );

  return (
    <div className={`relative ${className}`}>
      {scrollOnMobile && !mobile ? (
        <>
          <div
            role="region"
            aria-label="Product preview, scroll sideways to see the full screen"
            tabIndex={0}
            className="overflow-x-auto overscroll-x-contain rounded-b-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-teal-500 max-lg:pb-1"
          >
            <div className="min-w-[1000px] md:min-w-[900px] lg:min-w-0">{image}</div>
          </div>
          <p className="pointer-events-none px-3 py-1.5 text-center text-[11px] font-medium text-slate-400 lg:hidden">Swipe sideways to explore the full screen</p>
        </>
      ) : (
        image
      )}
      {tag ? (
        <SampleTag
          className={`absolute left-2.5 sm:left-3 ${
            scrollOnMobile && !mobile
              ? "bottom-9 sm:bottom-9 lg:bottom-3"
              : mobile
                ? "max-sm:bottom-auto max-sm:left-auto max-sm:right-2.5 max-sm:top-2.5 bottom-2.5 sm:bottom-3"
                : "bottom-2.5 sm:bottom-3"
          }`}
        />
      ) : null}
    </div>
  );
}
