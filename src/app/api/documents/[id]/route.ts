import { NextRequest, NextResponse } from "next/server";
import { deleteDocument, getDocument } from "@/lib/db";
import { invalidateVecCache } from "@/lib/retrieval";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const docId = Number(id);
  if (!getDocument(docId)) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }
  deleteDocument(docId);
  invalidateVecCache();
  return NextResponse.json({ ok: true });
}
