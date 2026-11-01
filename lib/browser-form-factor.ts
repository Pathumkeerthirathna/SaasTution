/*
 * Desktop vs mobile browser, for the teacher tab-close signal: closing
 * signals are sent from desktop browsers only (mobile browsers do not fire
 * pagehide reliably when a tab is closed, and suspend / discard pages in
 * ways a closing signal cannot describe). Plain functions, no server or DOM
 * imports: used by the classroom page and the signal route.
 *
 * Detection, strongest evidence first:
 * 1. User-Agent Client Hints: navigator.userAgentData.mobile (Chromium
 *    browsers), or the Sec-CH-UA-Mobile request header ("?1" = mobile).
 * 2. The User-Agent string: Android, iPhone, iPad, iPod, "Mobile", and other
 *    phone / tablet browsers.
 * 3. iPadOS Safari reports a desktop Mac User-Agent by default: a "MacIntel"
 *    platform with a touch screen (maxTouchPoints > 1) is an iPad.
 *
 * Unknown means NOT desktop: no navigator, no User-Agent. Limitations: a
 * mobile browser in "request desktop site" mode reports itself as desktop
 * (Chromium also sets userAgentData.mobile = false then), and a user can
 * change the User-Agent. Touch-screen Windows / Linux laptops and Chromebooks
 * stay desktop.
 */

const MOBILE_USER_AGENT =
  /Android|iPhone|iPad|iPod|Mobile|Mobi\b|IEMobile|Opera Mini|Opera Mobi|BlackBerry|BB10|webOS|Silk|Kindle|KAIOS|Windows Phone/i;

export function isMobileUserAgent(userAgent: string | null | undefined): boolean {
  return typeof userAgent === "string" && MOBILE_USER_AGENT.test(userAgent);
}

/** What the page can see of its browser (a subset of Navigator). */
export type BrowserNavigator = {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean } | null;
};

/** Whether this page runs in a desktop browser (see the header). Unknown: false. */
export function isDesktopBrowser(nav: BrowserNavigator | null | undefined): boolean {
  if (!nav || typeof nav.userAgent !== "string" || nav.userAgent.length === 0) return false;

  if (typeof nav.userAgentData?.mobile === "boolean" && nav.userAgentData.mobile) return false;
  if (isMobileUserAgent(nav.userAgent)) return false;

  // iPadOS Safari "desktop" mode: a Mac User-Agent on a touch screen.
  if (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1) return false;

  return true;
}

/** Whether a request comes from a mobile browser (Client Hint, else User-Agent). */
export function isMobileRequest(headers: Headers): boolean {
  if (headers.get("sec-ch-ua-mobile")?.trim() === "?1") return true;

  return isMobileUserAgent(headers.get("user-agent"));
}
