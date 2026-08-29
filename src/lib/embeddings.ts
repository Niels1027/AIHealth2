import { getConfig, type AppConfig } from "./config.ts";

// Embedding 双通道：本地 Ollama（默认，bge-m3）/ AI 网关（OpenAI 兼容）。
// 向量统一做 L2 归一化，检索时用点积即余弦相似度。

/** 允许临时传入一套配置（管理页「测试连接」用），不传则用当前生效配置 */
type EmbedOverride = Partial<
  Pick<
    AppConfig,
    | "embeddingProvider"
    | "ollamaBaseUrl"
    | "ollamaEmbedModel"
    | "aiBaseUrl"
    | "aiApiKey"
    | "gatewayEmbedModel"
  >
>;

function resolve(override?: EmbedOverride): AppConfig {
  return { ...getConfig(), ...(override ?? {}) };
}

function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

async function embedOllama(texts: string[], cfg: AppConfig): Promise<Float32Array[]> {
  const base = cfg.ollamaBaseUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.ollamaEmbedModel, input: texts }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new Error(
      `无法连接本地 Ollama（${base}）。请先启动 Ollama（运行 "ollama serve" 或打开 Ollama 应用）`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 404) {
      throw new Error(
        `Ollama 里没有模型「${cfg.ollamaEmbedModel}」。请先在终端运行：ollama pull ${cfg.ollamaEmbedModel}`
      );
    }
    throw new Error(`Ollama embedding 失败 (${res.status})：${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { embeddings?: number[][] };
  if (!data.embeddings?.length) throw new Error("Ollama 返回了空的 embedding 结果");
  return data.embeddings.map((e) => normalize(Float32Array.from(e)));
}

async function embedGateway(texts: string[], cfg: AppConfig): Promise<Float32Array[]> {
  const res = await fetch(`${cfg.aiBaseUrl.replace(/\/+$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.aiApiKey}`,
    },
    body: JSON.stringify({ model: cfg.gatewayEmbedModel, input: texts }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`网关 embedding 失败 (${res.status})：${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
  if (!data.data?.length) throw new Error("网关返回了空的 embedding 结果");
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => normalize(Float32Array.from(d.embedding)));
}

export async function embed(texts: string[], override?: EmbedOverride): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const cfg = resolve(override);
  return cfg.embeddingProvider === "gateway" ? embedGateway(texts, cfg) : embedOllama(texts, cfg);
}

export function embedModelName(cfg: AppConfig = getConfig()): string {
  return cfg.embeddingProvider === "gateway" ? cfg.gatewayEmbedModel : cfg.ollamaEmbedModel;
}

/** 当前 provider+model 的索引签名，用于检测"换了 embedding 模型但没重建索引" */
export function embedSignature(dim: number): string {
  const cfg = getConfig();
  return `${cfg.embeddingProvider}:${embedModelName(cfg)}:${dim}`;
}

export interface EmbeddingHealth {
  ok: boolean;
  provider: string;
  model: string;
  dim?: number;
  error?: string;
}

let healthCache: { at: number; key: string; result: EmbeddingHealth } | null = null;

/** 配置变更后清掉缓存，让状态立即反映新设置 */
export function invalidateEmbeddingHealth() {
  healthCache = null;
}

export async function embeddingHealth(): Promise<EmbeddingHealth> {
  const cfg = getConfig();
  const key = `${cfg.embeddingProvider}:${embedModelName(cfg)}:${cfg.ollamaBaseUrl}:${cfg.aiBaseUrl}`;
  if (healthCache && healthCache.key === key && Date.now() - healthCache.at < 10_000) {
    return healthCache.result;
  }
  const base = { provider: cfg.embeddingProvider, model: embedModelName(cfg) };
  let result: EmbeddingHealth;
  try {
    const [v] = await embed(["健康检查"]);
    result = { ok: true, ...base, dim: v.length };
  } catch (e) {
    result = { ok: false, ...base, error: e instanceof Error ? e.message : String(e) };
  }
  healthCache = { at: Date.now(), key, result };
  return result;
}
