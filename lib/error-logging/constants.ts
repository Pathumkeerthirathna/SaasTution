/** Where browsers send error reports (app/api/client-errors/route.ts). */
export const CLIENT_ERROR_ENDPOINT = "/api/client-errors";

/** Report bodies over this size are refused (413). */
export const CLIENT_ERROR_MAX_BODY_BYTES = 8 * 1024;
