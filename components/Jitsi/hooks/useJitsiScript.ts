"use client";

import { useEffect, useState } from "react";

export default function useJitsiScript(domain: string) {
  const [isJitsiReady, setIsJitsiReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!domain) {
      return;
    }

    const scriptUrl = `https://${domain}/external_api.js`;

    // If already loaded, don't load again
    const existingScript = document.querySelector(
      `script[src="${scriptUrl}"]`
    ) as HTMLScriptElement | null;

    if (existingScript && window.JitsiMeetExternalAPI) {
      setIsJitsiReady(true);
      return;
    }

    const script = document.createElement("script");
    script.src = scriptUrl;
    script.async = true;

    script.onload = () => {
      setIsJitsiReady(true);
    };

    script.onerror = () => {
      setErrorMessage(
        "Unable to load Jitsi script. Please check your network."
      );
    };

    document.body.appendChild(script);

    return () => {
      // Only remove the script if this hook added it
      if (!existingScript) {
        document.body.removeChild(script);
      }
    };
  }, [domain]);

  return {
    isJitsiReady,
    errorMessage,
  };
}