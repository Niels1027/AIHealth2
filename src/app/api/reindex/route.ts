import { NextResponse } from "next/server";
import { reindexAll } from "@/lib/ingest";

export async function POST() {
  try {
    await reindexAll();
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "重建索引失败";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
