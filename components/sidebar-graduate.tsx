/**
 * Cheering graduate holding a trophy on a stack of four labelled books
 * (Knowledge / Imagination / Adventure / Stories). Flat illustration used
 * as the anchor at the bottom of the expanded sidebar.
 */
export function SidebarGraduate() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 240 300"
      className="block w-full select-none"
      preserveAspectRatio="xMidYMax meet"
    >
      {/* soft glow behind the figure */}
      <ellipse cx="115" cy="90" rx="70" ry="70" fill="#8fb4ff" opacity="0.12" />

      {/* sparkles */}
      <g stroke="#f0c86a" strokeWidth="3.5" strokeLinecap="round" opacity="0.85">
        <line x1="52" y1="34" x2="44" y2="26" />
        <line x1="60" y1="60" x2="49" y2="58" />
        <line x1="92" y1="16" x2="88" y2="6" />
        <line x1="150" y1="30" x2="159" y2="22" />
        <line x1="160" y1="54" x2="171" y2="52" />
        <line x1="140" y1="14" x2="144" y2="4" />
      </g>

      {/* ── book stack ── */}
      {/* blue — KNOWLEDGE */}
      <g>
        <polygon points="40,150 52,142 190,142 178,150" fill="#3a5aa0" />
        <rect x="40" y="150" width="138" height="28" rx="4" fill="#23417e" />
        <rect x="40" y="150" width="10" height="28" fill="#1a3161" />
        <rect x="170" y="153" width="8" height="22" fill="#f3e9d2" />
        <line x1="58" y1="156" x2="164" y2="156" stroke="#d9b25b" strokeWidth="1.2" />
        <line x1="58" y1="172" x2="164" y2="172" stroke="#d9b25b" strokeWidth="1.2" />
        <text x="110" y="168" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontSize="11" letterSpacing="1.5" fill="#e7c987">KNOWLEDGE</text>
      </g>
      {/* green — IMAGINATION */}
      <g>
        <polygon points="30,180 42,172 206,172 194,180" fill="#57a04f" />
        <rect x="30" y="180" width="164" height="32" rx="4" fill="#3f7d3a" />
        <rect x="30" y="180" width="10" height="32" fill="#2f5f2c" />
        <rect x="186" y="184" width="8" height="24" fill="#f3e9d2" />
        <line x1="48" y1="187" x2="178" y2="187" stroke="#d9b25b" strokeWidth="1.2" />
        <line x1="48" y1="205" x2="178" y2="205" stroke="#d9b25b" strokeWidth="1.2" />
        <text x="112" y="200" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontSize="11.5" letterSpacing="1.5" fill="#e7c987">IMAGINATION</text>
      </g>
      {/* gold — ADVENTURE */}
      <g>
        <polygon points="20,214 32,206 220,206 208,214" fill="#efbb47" />
        <rect x="20" y="214" width="188" height="36" rx="4" fill="#e2a11d" />
        <rect x="20" y="214" width="10" height="36" fill="#b47c12" />
        <rect x="200" y="218" width="8" height="28" fill="#f3e9d2" />
        <line x1="40" y1="222" x2="190" y2="222" stroke="#8a5a17" strokeWidth="1.2" />
        <line x1="40" y1="242" x2="190" y2="242" stroke="#8a5a17" strokeWidth="1.2" />
        <text x="114" y="236" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontSize="12.5" letterSpacing="1.5" fill="#7a4e12">ADVENTURE</text>
      </g>
      {/* red — STORIES */}
      <g>
        <polygon points="12,252 24,244 228,244 216,252" fill="#c94b40" />
        <rect x="12" y="252" width="204" height="40" rx="4" fill="#b5372f" />
        <rect x="12" y="252" width="10" height="40" fill="#8a2a24" />
        <rect x="208" y="256" width="8" height="32" fill="#f3e9d2" />
        <line x1="32" y1="261" x2="196" y2="261" stroke="#d9b25b" strokeWidth="1.2" />
        <line x1="32" y1="283" x2="196" y2="283" stroke="#d9b25b" strokeWidth="1.2" />
        <text x="114" y="276" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontSize="13.5" letterSpacing="2" fill="#e7c987">STORIES</text>
      </g>

      {/* ── graduate ── */}
      <g>
        {/* shoes + legs */}
        <ellipse cx="103" cy="150" rx="8" ry="3.5" fill="#15181f" />
        <ellipse cx="127" cy="150" rx="8" ry="3.5" fill="#15181f" />
        <rect x="99" y="126" width="9" height="24" fill="#1f2430" />
        <rect x="122" y="126" width="9" height="24" fill="#1f2430" />

        {/* raised arm holding trophy (behind gown) */}
        <path d="M104 82 L78 44" stroke="#20263a" strokeWidth="11" strokeLinecap="round" />
        <circle cx="76" cy="42" r="5" fill="#f4c9a6" />
        {/* fist-pump arm */}
        <path d="M126 82 L146 62" stroke="#20263a" strokeWidth="11" strokeLinecap="round" />
        <circle cx="148" cy="60" r="5.5" fill="#f4c9a6" />

        {/* gown */}
        <path d="M97 133 Q115 142 133 133 L127 76 Q115 69 103 76 Z" fill="#20263a" />
        <path d="M115 78 L115 138" stroke="#171b26" strokeWidth="1.5" opacity="0.6" />
        <path d="M106 80 Q104 108 108 136" stroke="#171b26" strokeWidth="1.2" fill="none" opacity="0.5" />
        <path d="M124 80 Q126 108 122 136" stroke="#171b26" strokeWidth="1.2" fill="none" opacity="0.5" />

        {/* collar + tie */}
        <polygon points="107,76 115,92 123,76" fill="#ece6d6" />
        <path d="M108 77 L115 90 L122 77" stroke="#e0a41c" strokeWidth="2" fill="none" />
        <polygon points="112,80 118,80 116,99 114,99" fill="#c0392b" />

        {/* head */}
        <circle cx="115" cy="60" r="13" fill="#f4c9a6" />
        <ellipse cx="102" cy="61" rx="3" ry="3.5" fill="#f4c9a6" />
        <circle cx="108" cy="64" r="3" fill="#ef9d9d" opacity="0.75" />
        <circle cx="122" cy="64" r="3" fill="#ef9d9d" opacity="0.75" />
        <path d="M106 57 q3 -4 6 0" stroke="#2a1f1a" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M118 57 q3 -4 6 0" stroke="#2a1f1a" strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M110 65 q5 7 10 0 q-5 3 -10 0 Z" fill="#7a2f2b" />
        <path d="M111 65 q4 2 8 0 Z" fill="#ffffff" />

        {/* hair */}
        <path d="M103 52 q-1 -9 8 -11 q11 -2 14 8 q-4 -3 -9 -2 q-7 1 -13 5 Z" fill="#4a3728" />
        <path d="M102 52 q-2 6 1 10 q-4 -1 -4 -6 q0 -3 3 -4 Z" fill="#4a3728" />

        {/* mortarboard */}
        <path d="M104 49 Q115 45 126 49 L125 42 Q115 39 105 42 Z" fill="#171b24" />
        <polygon points="93,42 115,33 137,42 115,51" fill="#12151d" />
        <polygon points="93,42 115,33 137,42 115,51" fill="none" stroke="#2b3242" strokeWidth="1" />
        <circle cx="115" cy="42" r="2.2" fill="#0c0e14" />
        {/* tassel */}
        <path d="M115 42 Q133 44 135 46 L136 60" stroke="#f0c86a" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        <circle cx="136" cy="61" r="3.2" fill="#f0c86a" />
        <path d="M133 62 L133 68 M136 63 L136 69 M139 62 L139 68" stroke="#e0a41c" strokeWidth="1.4" strokeLinecap="round" />

        {/* trophy */}
        <g>
          <path d="M66 18 L86 18 L83 30 Q76 40 69 30 Z" fill="#f0b429" stroke="#d99e12" strokeWidth="1.5" />
          <path d="M66 20 q-8 1 -3 10 q2 4 6 4" stroke="#e0a41c" strokeWidth="2.5" fill="none" />
          <path d="M86 20 q8 1 3 10 q-2 4 -6 4" stroke="#e0a41c" strokeWidth="2.5" fill="none" />
          <rect x="73" y="36" width="6" height="5" fill="#d99e12" />
          <path d="M67 41 L85 41 L82 46 L70 46 Z" fill="#e0a41c" />
          <path d="M71 21 q0 6 3 10" stroke="#fce6ac" strokeWidth="2" fill="none" strokeLinecap="round" />
        </g>
      </g>
    </svg>
  );
}
