// Teacher settings: when Video Diagnostics may start and when it stops.
// Plain JavaScript with JSDoc types so the same code runs in the app
// (SidebarNav, VideoDiagnosticsSection) and in the Node test runner.
// Decisions only: turning diagnostics on / off is the caller's
// `setDiagnostics` (JitsiClassroom's existing handler).

/** The confirmation shown before diagnostics is turned on. */
export const VIDEO_DIAGNOSTICS_CONFIRM = Object.freeze({
  title: "Enable Video Diagnostics?",
  message:
    "Video Diagnostics collects video connection statistics and exchanges small diagnostic reports with " +
    "participants. This uses a small amount of additional internet data. It does not enable extra video " +
    "streams or increase video quality.",
  confirmLabel: "Enable Diagnostics",
  cancelLabel: "Cancel",
});

/**
 * The diagnostics switch and its confirmation. Turning it ON only opens the
 * confirmation; it starts after "Enable Diagnostics". Turning it OFF applies
 * at once. `toggle`: what to pass to the existing on / off handler, or null
 * for nothing (no request, no polling).
 *
 * @param {{ enabled: boolean, confirming: boolean }} state
 * @param {"switch" | "confirm" | "cancel"} action
 * @returns {{ confirming: boolean, toggle: boolean | null }}
 */
export function diagnosticsSwitchStep(state, action) {
  if (action === "switch") {
    return state.enabled ? { confirming: false, toggle: false } : { confirming: true, toggle: null };
  }

  if (action === "confirm") {
    return { confirming: false, toggle: state.confirming && !state.enabled ? true : null };
  }

  return { confirming: false, toggle: null };
}

/**
 * Closes the settings menu (gear button, Escape, a click outside it, or the
 * menu going away) and turns diagnostics OFF if it is on. Nothing is sent
 * when it is already off, so closing never adds a message.
 *
 * @param {{ diagnosticsOn: boolean, setSettingsOpen: (open: boolean) => void, setDiagnostics?: (enabled: boolean) => void }} options
 */
export function closeSettings({ diagnosticsOn, setSettingsOpen, setDiagnostics }) {
  setSettingsOpen(false);

  if (diagnosticsOn && typeof setDiagnostics === "function") {
    setDiagnostics(false);
  }
}

/**
 * The gear button: opens the menu, or closes it (as closeSettings).
 *
 * @param {{ isOpen: boolean, diagnosticsOn: boolean, setSettingsOpen: (open: boolean) => void, setDiagnostics?: (enabled: boolean) => void }} options
 */
export function toggleSettings({ isOpen, ...rest }) {
  if (isOpen) {
    closeSettings(rest);
  } else {
    rest.setSettingsOpen(true);
  }
}

/**
 * A key while the menu is open: Escape closes it (as closeSettings).
 *
 * @param {string} key
 * @param {{ diagnosticsOn: boolean, setSettingsOpen: (open: boolean) => void, setDiagnostics?: (enabled: boolean) => void }} options
 * @returns {boolean} whether the menu was closed
 */
export function settingsKeyDown(key, options) {
  if (key !== "Escape") {
    return false;
  }

  closeSettings(options);

  return true;
}
