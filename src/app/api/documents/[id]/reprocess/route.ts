import { NextRequest, NextResponse } from "next/server";
import { reprocessDocument } from "@/lib/ingest";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    reprocessDocument(Number(id), force);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "操作失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
