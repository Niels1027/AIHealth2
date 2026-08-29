import { NextResponse } from "next/server";
import { kbStats, getMeta } from "@/lib/db";
import { embeddingHealth } from "@/lib/embeddings";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const embedding = await embeddingHealth();
  const cfg = getConfig();
  return NextResponse.json({
    embedding,
    chat: {
      model: cfg.chatModel,
      utilityModel: cfg.utilityModel,
      baseUrl: cfg.aiBaseUrl,
      keyPresent: !!cfg.aiApiKey,
    },
    indexSignature: getMeta("embed_signature"),
    stats: kbStats(),
  });
}
