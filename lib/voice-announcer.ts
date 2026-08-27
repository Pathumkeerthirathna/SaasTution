"use client";

/**
 * Speaks a short announcement using the browser's built-in text-to-speech
 * engine, preferring a warm, female-sounding voice when one is available.
 * No-ops silently in environments without speech synthesis support.
 */

const FEMALE_VOICE_HINTS = [
    "female",
    "zira",
    "samantha",
    "victoria",
    "karen",
    "moira",
    "tessa",
    "susan",
    "fiona",
    "google us english",
    "google uk english female",
];

function pickFemaleVoice(
    voices: SpeechSynthesisVoice[]
): SpeechSynthesisVoice | undefined {
    const englishVoices = voices.filter((voice) =>
        voice.lang?.toLowerCase().startsWith("en")
    );

    const candidates =
        englishVoices.length > 0 ? englishVoices : voices;

    return candidates.find((voice) =>
        FEMALE_VOICE_HINTS.some((hint) =>
            voice.name.toLowerCase().includes(hint)
        )
    );
}

function speakWithVoices(
    text: string,
    voices: SpeechSynthesisVoice[]
) {
    const utterance = new SpeechSynthesisUtterance(text);

    const femaleVoice = pickFemaleVoice(voices);

    if (femaleVoice) {
        utterance.voice = femaleVoice;
    }

    utterance.pitch = 1.15;
    utterance.rate = 1;
    utterance.volume = 1;

    window.speechSynthesis.speak(utterance);
}

export function announce(text: string) {
    if (
        typeof window === "undefined" ||
        !("speechSynthesis" in window)
    ) {
        return;
    }

    const voices = window.speechSynthesis.getVoices();

    if (voices.length > 0) {
        speakWithVoices(text, voices);
        return;
    }

    // Some browsers load voices asynchronously.
    window.speechSynthesis.onvoiceschanged = () => {
        speakWithVoices(
            text,
            window.speechSynthesis.getVoices()
        );

        window.speechSynthesis.onvoiceschanged = null;
    };
}
