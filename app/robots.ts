import type { MetadataRoute } from "next";

import { siteOrigin } from "@/lib/site-url";

/*
 * /robots.txt. Public teacher profiles (/{slug}), their preview images
 * (/{slug}/opengraph-image, /{slug}/twitter-image) and public photos
 * (/api/teacher-photos/, /uploads/teachers/) stay crawlable.
 *
 * Private application areas are excluded from indexing. Teacher profiles are
 * single root-level segments, so each area is listed as its exact path ("$")
 * and its subtree ("/"): a teacher slug that merely STARTS with the same
 * letters (e.g. "/dashboard-maths") is never blocked.
 *
 * robots.txt is not access control: every private page and API checks the
 * session and the profile's visibility on the server.
 */

const PRIVATE_AREAS = ["/dashboard", "/student", "/account", "/guardian", "/session", "/teacher", "/login", "/register", "/reset-password"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/api/teacher-photos/", "/uploads/teachers/"],
        disallow: ["/api/", ...PRIVATE_AREAS.flatMap((area) => [`${area}$`, `${area}/`])],
      },
    ],
    host: siteOrigin(),
  };
}
