"use client";

import { useEffect, useState } from "react";

export default function useMicrophoneLevel(
  stream: MediaStream | null
) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream) return;

    const audioContext = new AudioContext();

    const analyser =
      audioContext.createAnalyser();

    analyser.fftSize = 256;

    const source =
      audioContext.createMediaStreamSource(stream);

    source.connect(analyser);

    const data = new Uint8Array(
      analyser.frequencyBinCount
    );

    let animationId = 0;

    const update = () => {
      analyser.getByteFrequencyData(data);

      const average =
        data.reduce((a, b) => a + b, 0) /
        data.length;

      setLevel(Math.min(100, average));

      animationId =
        requestAnimationFrame(update);
    };

    update();

    return () => {
      cancelAnimationFrame(animationId);
      audioContext.close();
    };
  }, [stream]);

  return level;
}