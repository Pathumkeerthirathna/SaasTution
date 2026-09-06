import {
  Atom,
  BookOpen,
  Calculator,
  Compass,
  FlaskConical,
  Microscope,
  Pencil,
  Sigma,
} from "lucide-react";

export function hashString(value: string) {
  let hash = 0;

  for (let i = 0; i < value.length; i++) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash);
  }

  return Math.abs(hash);
}

// A single navy-blue theme (matching the app's confirmed brand palette) is
// used for every class card instead of the old per-class rainbow rotation,
// so class cards read consistently with the rest of the blue-branded UI.
const CLASS_CARD_THEMES = [
  {
    gradient: "from-[#32598A] via-[#264867] to-[#1a3049]",
    glow1: "bg-[#5b85ac]/20",
    glow2: "bg-[#8fb0cd]/10",
    iconColor: "text-[#dce7f1]",
    metaText: "text-[#dce7f1]/80",
    badgeBorder: "border-[#8fb0cd]/30",
    badgeBg: "bg-[#5b85ac]/15",
    badgeDot: "bg-[#8fb0cd]",
    badgeText: "text-[#eef3f8]",
    bookGradient: "from-[#5b85ac] to-[#264867]",
    numberColor: "text-[#8fb0cd]",
  },
] as const;

const CLASS_CARD_ICONS = [
  Sigma,
  Compass,
  FlaskConical,
  Atom,
  Calculator,
  Microscope,
  BookOpen,
  Pencil,
];

export function getClassCardTheme(classId: string) {
  return CLASS_CARD_THEMES[hashString(classId) % CLASS_CARD_THEMES.length];
}

export function getClassCardIcon(classId: string) {
  return CLASS_CARD_ICONS[
    hashString(`${classId}-icon`) % CLASS_CARD_ICONS.length
  ];
}

export function getClassBookLabel(name: string) {
  const firstPart = name.split(/[-–—]/)[0]?.trim() || name.trim();
  const firstWord = firstPart.split(/\s+/)[0] || firstPart;
  return firstWord.slice(0, 8).toUpperCase();
}

export function getClassNumber(name: string) {
  const digits = name.match(/\d+/g);

  if (digits && digits.length > 0) {
    return String(Number(digits[digits.length - 1]));
  }

  return getClassBookLabel(name).charAt(0);
}

export function ClassBookBadge({
  label,
  number,
  bookGradient,
  numberColor,
}: {
  label: string;
  number: string;
  bookGradient: string;
  numberColor: string;
}) {
  return (
    <div className="pointer-events-none absolute right-6 top-1/2 h-24 w-28 -translate-y-1/2 opacity-[0.55] mix-blend-luminosity">

      {/* Decorative sparkle dots */}
      <span className="absolute right-2 top-0.5 h-1 w-1 rounded-full bg-white/40" />
      <span className="absolute right-7 top-2.5 h-1 w-1 rounded-full bg-white/25" />
      <span className="absolute right-4 top-4 h-0.5 w-0.5 rounded-full bg-white/30" />

      {/* Bold numeral, sitting behind the book */}
      <span
        className={`absolute right-2 top-1/2 -translate-y-1/2 select-none text-5xl font-black leading-none ${numberColor} opacity-60`}
      >
        {number}
      </span>

      {/* Book */}
      <div className="absolute left-2 top-1 h-20 w-[60px] rotate-[8deg]">

        {/* Page edges */}
        <div className="absolute inset-y-1 -right-1 w-2.5 rounded-r-sm bg-slate-100/70" />
        <div className="absolute inset-y-1.5 -right-0.5 w-2 rounded-r-sm bg-white/70" />

        {/* Cover */}
        <div
          className={`relative flex h-full w-full items-center justify-center rounded-md bg-gradient-to-br ${bookGradient} shadow-md ring-1 ring-black/5`}
        >
          {/* Spine shadow */}
          <div className="absolute inset-y-0 left-0 w-2.5 rounded-l-md bg-black/10" />

          {/* Glossy highlight */}
          <div className="absolute inset-x-2.5 top-1.5 h-1/3 rounded-full bg-white/10 blur-[2px]" />

          <span className="relative px-1 text-center text-[11px] font-extrabold uppercase leading-tight tracking-wide text-white/90">
            {label}
          </span>
        </div>
      </div>

      {/* Pencil */}
      <div className="absolute left-0 bottom-2 h-20 w-2.5 rotate-[40deg]">
        {/* Shaft */}
        <div className="absolute bottom-0 h-[72%] w-full rounded-sm bg-gradient-to-b from-orange-300/80 to-orange-400/80" />

        {/* Metal band */}
        <div className="absolute bottom-[72%] h-1.5 w-full bg-slate-300/80" />

        {/* Wood taper */}
        <div
          className="absolute bottom-[calc(72%+6px)] h-3 w-full bg-amber-200/80"
          style={{ clipPath: "polygon(0% 0%, 100% 0%, 65% 100%, 35% 100%)" }}
        />

        {/* Graphite tip */}
        <div
          className="absolute bottom-[calc(72%+18px)] h-1.5 w-full bg-slate-600/80"
          style={{ clipPath: "polygon(35% 0%, 65% 0%, 50% 100%)" }}
        />
      </div>

    </div>
  );
}
