import { renderTeacherShareImage, SHARE_IMAGE_ALT, SHARE_IMAGE_SIZE } from "@/lib/teacher-profile/share-image";
import { getPublicTeacherShareData } from "@/services/teacher-profile-service";

/*
 * The Open Graph preview image of a PUBLIC teacher profile (1200 x 630 PNG).
 * Next.js links it as og:image (absolute, via metadataBase). Visibility is
 * enforced HERE as well, independently of the page: an unknown or private
 * profile gets a 404 and no image is generated.
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
