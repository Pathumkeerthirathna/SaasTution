import { promises as fs } from "fs";
import path from "path";

export async function GET(
  request: Request,
  { params }: { params: { filename: string } }
) {
  const filePath = path.join(
    process.cwd(),
    "storage",
    "teachers",
    params.filename
  );

  try {
    const file = await fs.readFile(filePath);

    const ext = path.extname(params.filename).toLowerCase();

    const types: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".svg": "image/svg+xml",
    };

    return new Response(file, {
      headers: {
        "Content-Type": types[ext] || "application/octet-stream",
        "Cache-Control": "public,max-age=31536000,immutable",
      },
    });
  } catch {
    return new Response("Not Found", {
      status: 404,
    });
  }
}