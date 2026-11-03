/*
 * The browser's error report, as sent to POST /api/client-errors (shared by
 * the reporter and the endpoint). The endpoint accepts exactly these fields,
 * with these limits; anything else is rejected.
 */

import { z } from "zod";

export { CLIENT_ERROR_ENDPOINT, CLIENT_ERROR_MAX_BODY_BYTES } from "./constants";

export const clientErrorReportSchema = z
  .object({
    source: z.enum(["client", "react"]),
    kind: z.string().regex(/^[A-Za-z0-9:._-]{1,60}$/),
    name: z.string().max(200).optional(),
    message: z.string().max(2000),
    stack: z.string().max(6000).optional(),
    digest: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).optional(),
    route: z.string().max(500).optional(),
    clientEventId: z.string().regex(/^[a-z0-9]{8,32}$/).optional(),
  })
  .strict();

export type ClientErrorReport = z.infer<typeof clientErrorReportSchema>;
