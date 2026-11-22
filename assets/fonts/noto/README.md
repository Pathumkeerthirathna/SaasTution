# Noto fonts for the teacher profile share image

These fonts are used ONLY on the server, to draw the 1200 x 630 link-preview
image of a public teacher profile (`lib/teacher-profile/share-fonts.ts`). They
are read from this folder at runtime (`<cwd>/assets/fonts/noto`), so the
production server needs no system fonts. They are never served to browsers.

| File | Script | Licence |
| --- | --- | --- |
| `NotoSans-Regular.ttf` | Latin, Greek, Cyrillic | SIL OFL 1.1 (`OFL-NotoSans.txt`) |
| `NotoSansSinhala-Regular.ttf` | Sinhala | SIL OFL 1.1 (`OFL-NotoSansSinhala.txt`) |
| `NotoSansTamil-Regular.ttf` | Tamil | SIL OFL 1.1 (`OFL-NotoSansTamil.txt`) |

Source: the static, hinted TTFs from the Noto project
(`https://github.com/notofonts/notofonts.github.io`, `fonts/<Family>/hinted/ttf/`),
downloaded on 2026-11-22. Static (not variable) fonts are required: the image
renderer does not support variable fonts.

SHA-256:

```
478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823  NotoSans-Regular.ttf
9e32612d47004552f3125e78648a9e2e7899a216ccd3cefbb93a9b5f4c809feb  NotoSansSinhala-Regular.ttf
3c0a186feb3c63c7f6d63e1511dcdc144e745ae09b98e217c83f3e317974f6f9  NotoSansTamil-Regular.ttf
```

Sinhala and Tamil need OpenType shaping (pre-base vowel signs, conjuncts, ZWJ
forms). The layout engine behind `next/og` (satori) does not shape, so text in
those scripts is drawn by pango + HarfBuzz through `sharp`, using these same
files, and embedded in the image as a picture of the text.
