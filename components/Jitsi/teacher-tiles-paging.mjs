// Teacher Tiles view paging (Normal mode). Plain JavaScript with JSDoc types
// so the same code runs in the app (useTeacherTiles) and in the Node test
// runner (tests/jitsi). Exam Mode keeps its own paging (useCameraMonitoring).

/** Students per page the teacher can choose in the Tiles view. */
export const TEACHER_TILES_PAGE_SIZES = Object.freeze([10, 20, 30, 40, 50]);

/** Starting page size: a full 18-camera window plus a little rotation. */
export const DEFAULT_TEACHER_TILES_PAGE_SIZE = 20;

/**
 * @param {unknown} value
 * @returns {value is number}
 */
export function isTeacherTilesPageSize(value) {
  return typeof value === "number" && TEACHER_TILES_PAGE_SIZES.includes(value);
}

/**
 * One page of participant IDs, in the given (roster) order. A requested page
 * past the end (students left) is clamped to the last page.
 *
 * @param {{ ids: string[], pageSize: number, requestedPageIndex: number }} input
 * @returns {{
 *   pageIndex: number,
 *   pageCount: number,
 *   pageIds: string[],
 *   page: number,
 *   rangeStart: number,
 *   rangeEnd: number,
 *   total: number
 * }}
 */
export function computeTilesPage({ ids, pageSize, requestedPageIndex }) {
  const list = Array.isArray(ids) ? ids : [];
  const size = isTeacherTilesPageSize(pageSize) ? pageSize : DEFAULT_TEACHER_TILES_PAGE_SIZE;
  const total = list.length;
  const pageCount = Math.ceil(total / size);
  const requested = Number.isInteger(requestedPageIndex) && requestedPageIndex > 0 ? requestedPageIndex : 0;
  const pageIndex = Math.min(requested, Math.max(pageCount - 1, 0));
  const pageIds = list.slice(pageIndex * size, (pageIndex + 1) * size);

  return {
    pageIndex,
    pageCount,
    pageIds,
    page: pageCount === 0 ? 0 : pageIndex + 1,
    rangeStart: pageIds.length === 0 ? 0 : pageIndex * size + 1,
    rangeEnd: pageIndex * size + pageIds.length,
    total
  };
}

/**
 * The page index after Previous / Next, from the latest requested index (not
 * a rendered snapshot), so quick repeated presses each move one page. The
 * requested index may be past the end (students left): it is clamped first.
 *
 * @param {number} requestedPageIndex
 * @param {number} pageCount
 * @param {"previous" | "next"} action
 * @returns {number}
 */
export function stepPageIndex(requestedPageIndex, pageCount, action) {
  const last = Math.max((Number.isInteger(pageCount) ? pageCount : 0) - 1, 0);
  const current = Math.min(Number.isInteger(requestedPageIndex) && requestedPageIndex > 0 ? requestedPageIndex : 0, last);

  if (action === "previous") {
    return Math.max(current - 1, 0);
  }

  if (action === "next") {
    return Math.min(current + 1, last);
  }

  return current;
}

/**
 * The page to show after a page-size change: the one that holds the first
 * student currently shown.
 *
 * @param {number} pageIndex
 * @param {number} oldPageSize
 * @param {number} newPageSize
 * @returns {number}
 */
export function pageIndexAfterPageSizeChange(pageIndex, oldPageSize, newPageSize) {
  if (!(oldPageSize > 0) || !(newPageSize > 0) || !(pageIndex > 0)) {
    return 0;
  }

  return Math.floor((pageIndex * oldPageSize) / newPageSize);
}
