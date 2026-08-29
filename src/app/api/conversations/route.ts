import { NextRequest, NextResponse } from "next/server";
import { db, now } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const conversations = db
    .prepare(
      `SELECT c.id, c.title, c.updated_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conv_id = c.id) AS msg_count
       FROM conversations c
       ORDER BY c.updated_at DESC LIMIT 50`
    )
    .all();
  return NextResponse.json({ conversations });
}

export async function POST(_req: NextRequest) {
  const t = now();
  const res = db
    .prepare("INSERT INTO conversations(title, created_at, updated_at) VALUES('新对话', ?, ?)")
    .run(t, t);
  return NextResponse.json({ id: Number(res.lastInsertRowid) });
}
