import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getMessages } from "@/lib/rag";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const convId = Number(id);
  const conv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(convId);
  if (!conv) return NextResponse.json({ error: "对话不存在" }, { status: 404 });
  const messages = getMessages(convId).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    sources: m.sources ? JSON.parse(m.sources) : null,
    createdAt: m.created_at,
  }));
  return NextResponse.json({ conversation: conv, messages });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const convId = Number(id);
  db.prepare("DELETE FROM messages WHERE conv_id = ?").run(convId);
  db.prepare("DELETE FROM conversations WHERE id = ?").run(convId);
  return NextResponse.json({ ok: true });
}
