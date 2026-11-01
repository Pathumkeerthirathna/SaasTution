// Classroom fullscreen: the browser's Fullscreen API on the classroom's own
// meeting wrapper (JitsiMeeting.tsx), feature-detected, never by user agent.
// Plain JavaScript with JSDoc types so the same code runs in the app
// (JitsiMeeting, JitsiClassroom) and in the Node test runner.
//
// Real element fullscreen (Android Chrome, desktop, iPadOS) lets the browser
// hide its own address bar / tabs / navigation bar; navigationUI "hide" asks
// for the most screen it allows. Where it is unavailable (iPhone Safari:
// document.fullscreenEnabled is false) or refused, callers use the CSS
// fallback instead, which can only fill the viewport the browser leaves.

/** Both the standard and Safari's prefixed fullscreen change events. */
export const FULLSCREEN_CHANGE_EVENTS = Object.freeze(["fullscreenchange", "webkitfullscreenchange"]);

/**
 * The element in fullscreen, or null.
 *
 * @param {Document} doc
 * @returns {Element | null}
 */
export function getFullscreenElement(doc) {
  return doc.fullscreenElement ?? /** @type {any} */ (doc).webkitFullscreenElement ?? null;
}

/**
 * Whether this document may put an element in fullscreen (the API exists and
 * the page / Permissions Policy allows it). False on iPhone Safari.
 *
 * @param {Document | undefined} doc
 * @returns {boolean}
 */
export function isFullscreenApiEnabled(doc) {
  return Boolean(doc) && (doc.fullscreenEnabled === true || /** @type {any} */ (doc).webkitFullscreenEnabled === true);
}

/**
 * Puts `element` in fullscreen. Must be called from the user's click (no
 * await before it). Resolves once the browser agreed, rejects when it is
 * unavailable or refused.
 *
 * @param {Element | null | undefined} element
 * @returns {Promise<void>}
 */
export function requestElementFullscreen(element) {
  const target = /** @type {any} */ (element);

  try {
    if (target && typeof target.requestFullscreen === "function") {
      return Promise.resolve(target.requestFullscreen({ navigationUI: "hide" }));
    }

    // Older Safari: prefixed, returns nothing, answers with an event.
    if (target && typeof target.webkitRequestFullscreen === "function") {
      const doc = target.ownerDocument;

      return new Promise((resolve, reject) => {
        const settle = (ok) => {
          doc.removeEventListener("webkitfullscreenchange", onChange);
          doc.removeEventListener("webkitfullscreenerror", onError);

          if (ok) {
            resolve();
          } else {
            reject(new Error("Fullscreen request was refused."));
          }
        };
        const onChange = () => settle(true);
        const onError = () => settle(false);

        doc.addEventListener("webkitfullscreenchange", onChange);
        doc.addEventListener("webkitfullscreenerror", onError);
        target.webkitRequestFullscreen();
      });
    }
  } catch (error) {
    return Promise.reject(error);
  }

  return Promise.reject(new Error("Fullscreen API is not available on this element."));
}

/**
 * Leaves real fullscreen, if any.
 *
 * @param {Document} doc
 * @returns {Promise<void>}
 */
export function exitElementFullscreen(doc) {
  const target = /** @type {any} */ (doc);

  if (!getFullscreenElement(doc)) {
    return Promise.resolve();
  }

  try {
    if (typeof target.exitFullscreen === "function") {
      return Promise.resolve(target.exitFullscreen());
    }

    if (typeof target.webkitExitFullscreen === "function") {
      target.webkitExitFullscreen();
    }
  } catch (error) {
    return Promise.reject(error);
  }

  return Promise.resolve();
}

/**
 * The classroom's fullscreen button: real fullscreen when the browser allows
 * it, otherwise (unavailable or refused) "fallback", for the CSS mode.
 *
 * @param {Document | undefined} doc
 * @param {() => Promise<void> | undefined} request  requests real fullscreen (called synchronously)
 * @returns {Promise<"native" | "fallback">}
 */
export function enterClassroomFullscreen(doc, request) {
  if (!isFullscreenApiEnabled(doc)) {
    return Promise.resolve("fallback");
  }

  let pending;

  try {
    pending = request();
  } catch {
    return Promise.resolve("fallback");
  }

  if (!pending) {
    return Promise.resolve("fallback");
  }

  return Promise.resolve(pending).then(() => "native", (error) => {
    console.warn("Fullscreen refused, using the CSS fallback instead:", error);

    return "fallback";
  });
}
