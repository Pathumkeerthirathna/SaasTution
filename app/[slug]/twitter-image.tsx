import { renderTeacherShareImage, SHARE_IMAGE_ALT, SHARE_IMAGE_SIZE } from "@/lib/teacher-profile/share-image";
import { getPublicTeacherShareData } from "@/services/teacher-profile-service";

/*
 * The Twitter / X preview image (twitter:image, summary_large_image): the
 * same 1200 x 630 image as opengraph-image.tsx, with the same independent
 * visibility check (404 for unknown or private profiles).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = SHARE_IMAGE_ALT;
export const size = SHARE_IMAGE_SIZE;
export const contentType = "image/png";

export default async function Image({ params }: { params: { slug: string } }) {
  const data = await getPublicTeacherShareData(params.slug);
  if (!data) {
    return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  return renderTeacherShareImage(data);
}
