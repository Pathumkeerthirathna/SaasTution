import FingerprintJS from "@fingerprintjs/fingerprintjs";
import { UAParser } from "ua-parser-js";

export async function getCurrentDevice() {
  // Generate browser fingerprint
  const fp = await FingerprintJS.load();
  const fingerprint = await fp.get();

  // Parse browser information
  const parser = new UAParser();
  const result = parser.getResult();

  return {
    deviceId: fingerprint.visitorId,
    fingerprint: JSON.stringify(fingerprint.components),

    browser: result.browser.name ?? null,
    browserVersion: result.browser.version ?? null,

    os: result.os.name ?? null,
    osVersion: result.os.version ?? null,

    deviceModel: result.device.model ?? null,

    // Desktop browsers usually don't expose a device name,
    // so we'll generate one.
    deviceName:
      result.device.model ??
      `${result.browser.name ?? "Unknown"} on ${result.os.name ?? "Unknown"}`,

    platform: navigator.platform,
    userAgent: navigator.userAgent,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}