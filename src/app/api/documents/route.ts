import { NextRequest, NextResponse } from "next/server";
import { listDocuments } from "@/lib/db";
import { parseUpload } from "@/lib/parsers";
import { createDocumentWithChunks, startIngest } from "@/lib/ingest";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ documents: listDocuments() });
}

export async function POST(req: NextRequest) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    let title: string;
    let source: string;
    let text: string;

    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "缺少文件" }, { status: 400 });
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const parsed = parseUpload(file.name, buf);
      const customTitle = String(form.get("title") ?? "").trim();
      title = customTitle || parsed.title;
      source = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase() || "file";
      text = parsed.text;
    } else {
      const body = (await req.json()) as { title?: string; text?: string };
      title = String(body.title ?? "").trim() || "粘贴的文本";
      source = "paste";
      text = String(body.text ?? "");
    }

    const docId = createDocumentWithChunks(title, source, text);
    startIngest(docId);
    return NextResponse.json({ id: docId });
  } catch (e) {
    const message = e instanceof Error ? e.message : "上传失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
