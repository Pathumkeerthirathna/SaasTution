import { UAParser } from "ua-parser-js";

export function getDeviceInfo() {
  const parser = new UAParser();
  const result = parser.getResult();

  return {
    browser: result.browser.name,
    browserVersion: result.browser.version,

    os: result.os.name,
    osVersion: result.os.version,

    deviceModel: result.device.model,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  };
}