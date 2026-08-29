import { NextRequest, NextResponse } from "next/server";
import {
  CONFIG_KEYS,
  envDefaults,
  getConfig,
  maskKey,
  overriddenKeys,
  resetConfig,
  saveConfig,
  type AppConfig,
} from "@/lib/config";
import { invalidateEmbeddingHealth } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

/** 当前设置。密钥只回传打码结果，真实值不出服务端。 */
export async function GET() {
  const cfg = getConfig();
  return NextResponse.json({
    settings: { ...cfg, aiApiKey: maskKey(cfg.aiApiKey) },
    hasKey: !!cfg.aiApiKey,
    overridden: overriddenKeys(),
    envDefaults: { ...envDefaults(), aiApiKey: maskKey(envDefaults().aiApiKey) },
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<AppConfig> & { resetToEnv?: boolean };

    if (body.resetToEnv) {
      resetConfig();
      invalidateEmbeddingHealth();
      return NextResponse.json({ ok: true, reset: true });
    }

    const patch: Partial<AppConfig> = {};
    for (const key of CONFIG_KEYS) {
      const value = body[key];
      if (typeof value !== "string") continue;
      // 密钥留空表示"不改动"，避免打码值把真实密钥覆盖掉
      if (key === "aiApiKey" && (!value.trim() || value.includes("••"))) continue;
      patch[key] = value.trim() as never;
    }

    if (patch.aiBaseUrl && !/^https?:\/\//i.test(patch.aiBaseUrl)) {
      return NextResponse.json({ error: "网关地址需要以 http:// 或 https:// 开头" }, { status: 400 });
    }
    if (patch.ollamaBaseUrl && !/^https?:\/\//i.test(patch.ollamaBaseUrl)) {
      return NextResponse.json(
        { error: "Ollama 地址需要以 http:// 或 https:// 开头" },
        { status: 400 }
      );
    }
    if (patch.embeddingProvider && !["ollama", "gateway"].includes(patch.embeddingProvider)) {
      return NextResponse.json({ error: "向量化方式只能是 ollama 或 gateway" }, { status: 400 });
    }

    saveConfig(patch);
    invalidateEmbeddingHealth();
    const cfg = getConfig();
    return NextResponse.json({
      ok: true,
      settings: { ...cfg, aiApiKey: maskKey(cfg.aiApiKey) },
      overridden: overriddenKeys(),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "保存失败" },
      { status: 400 }
    );
  }
}
