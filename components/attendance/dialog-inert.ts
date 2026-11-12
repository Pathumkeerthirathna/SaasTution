/*
 * Background inertness for a modal dialog rendered in place (the attendance
 * finalization dialog, Stage 5.5d-4 follow-up). Framework-free and
 * DOM-light (tested with fake nodes).
 *
 * makeOutsideInert(dialogRoot, stopAt) walks from the dialog's root up to
 * `stopAt` (document.body) and sets the native `inert` attribute on every
 * sibling element at each level: the sidebar, the header, the register
 * behind the dialog, other body children (portals, the toaster). The
 * dialog and its own ancestors are never made inert, so the dialog stays
 * fully interactive. Elements that were already inert are left alone, and
 * the returned restore() removes only the attributes this call added (once).
 * <script>, <style>, <link>, <meta>, <template> and <noscript> are skipped.
 */

export type InertNode = {
  tagName: string;
  parentElement: InertNode | null;
  children: ArrayLike<InertNode>;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "LINK", "META", "TEMPLATE", "NOSCRIPT"]);

/** Makes everything outside `dialogRoot` (up to `stopAt`) inert; returns restore(). */
export function makeOutsideInert(dialogRoot: InertNode, stopAt: InertNode | null): () => void {
  const changed: InertNode[] = [];
  let node: InertNode = dialogRoot;
  while (node !== stopAt && node.parentElement) {
    const parent: InertNode = node.parentElement;
    for (const sibling of Array.from(parent.children)) {
      if (sibling === node || SKIPPED_TAGS.has(sibling.tagName.toUpperCase()) || sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      changed.push(sibling);
    }
    node = parent;
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const element of changed) element.removeAttribute("inert");
  };
}
