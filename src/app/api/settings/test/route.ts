import { NextRequest, NextResponse } from "next/server";
import { chatComplete, listGatewayModels } from "@/lib/ai";
import { getConfig, type AppConfig } from "@/lib/config";
import { embed } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

interface TestBody extends Partial<AppConfig> {
  /** models = 只拉取模型列表；full = 实测对话 + 向量化 */
  action?: "models" | "full";
}

/**
 * 管理页「测试连接 / 拉取模型」。用表单里的临时值测试，不落库，
 * 这样用户能先确认配置可用再保存。密钥留空则沿用已保存的。
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as TestBody;
  const saved = getConfig();
  const baseUrl = (body.aiBaseUrl || saved.aiBaseUrl).replace(/\/+$/, "");
  const apiKey =
    body.aiApiKey && !body.aiApiKey.includes("••") ? body.aiApiKey : saved.aiApiKey;

  if (body.action === "models") {
    try {
      return NextResponse.json({ models: await listGatewayModels(baseUrl, apiKey) });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "获取模型列表失败" },
        { status: 400 }
      );
    }
  }

  const chatModel = body.chatModel || saved.chatModel;
  const utilityModel = body.utilityModel || saved.utilityModel;
  const provider = (body.embeddingProvider as AppConfig["embeddingProvider"]) || saved.embeddingProvider;

  const probe = async (label: string, run: () => Promise<string>) => {
    const started = Date.now();
    try {
      return { label, ok: true as const, detail: await run(), ms: Date.now() - started };
    } catch (e) {
      return {
        label,
        ok: false as const,
        detail: e instanceof Error ? e.message : String(e),
        ms: Date.now() - started,
      };
    }
  };

  const results = await Promise.all([
    probe(`回答模型 ${chatModel}`, async () => {
      const out = await chatComplete({
        model: chatModel,
        baseUrl,
        apiKey,
        maxTokens: 20,
        messages: [{ role: "user", content: "回复两个字：可用" }],
      });
      return out.trim().slice(0, 40) || "（返回为空）";
    }),
    probe(`辅助模型 ${utilityModel}`, async () => {
      const out = await chatComplete({
        model: utilityModel,
        baseUrl,
        apiKey,
        maxTokens: 20,
        messages: [{ role: "user", content: "回复两个字：可用" }],
      });
      return out.trim().slice(0, 40) || "（返回为空）";
    }),
    probe(
      provider === "gateway"
        ? `向量化 ${body.gatewayEmbedModel || saved.gatewayEmbedModel}（网关）`
        : `向量化 ${body.ollamaEmbedModel || saved.ollamaEmbedModel}（本地 Ollama）`,
      async () => {
        const [v] = await embed(["连接测试"], {
          embeddingProvider: provider,
          ollamaBaseUrl: body.ollamaBaseUrl || saved.ollamaBaseUrl,
          ollamaEmbedModel: body.ollamaEmbedModel || saved.ollamaEmbedModel,
          aiBaseUrl: baseUrl,
          aiApiKey: apiKey,
          gatewayEmbedModel: body.gatewayEmbedModel || saved.gatewayEmbedModel,
        });
        return `${v.length} 维向量`;
      }
    ),
  ]);

  return NextResponse.json({ results, allOk: results.every((r) => r.ok) });
}
