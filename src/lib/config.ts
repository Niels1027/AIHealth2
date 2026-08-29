import { db } from "./db.ts";

// 运行时配置：以 .env.local 为默认值，管理页保存的设置存进 meta 表并覆盖默认值。
// 所有调用点都用 getConfig() 实时读取，改完设置立即生效，不需要重启服务。

export interface AppConfig {
  aiBaseUrl: string;
  aiApiKey: string;
  chatModel: string;
  utilityModel: string;
  embeddingProvider: "ollama" | "gateway";
  ollamaBaseUrl: string;
  ollamaEmbedModel: string;
  gatewayEmbedModel: string;
}

export const CONFIG_KEYS = [
  "aiBaseUrl",
  "aiApiKey",
  "chatModel",
  "utilityModel",
  "embeddingProvider",
  "ollamaBaseUrl",
  "ollamaEmbedModel",
  "gatewayEmbedModel",
] as const;

/** .env.local / 环境变量提供的默认值 */
export function envDefaults(): AppConfig {
  return {
    aiBaseUrl: process.env.AI_BASE_URL ?? "https://ai.buidlerdao.xyz/v1",
    aiApiKey: process.env.AI_API_KEY ?? "",
    chatModel: process.env.CHAT_MODEL ?? "gpt-5.4",
    utilityModel: process.env.UTILITY_MODEL ?? "deepseek-v4-flash",
    embeddingProvider: (process.env.EMBEDDING_PROVIDER ?? "ollama") as "ollama" | "gateway",
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL ?? "bge-m3",
    gatewayEmbedModel: process.env.GATEWAY_EMBED_MODEL ?? "text-embedding-3-small",
  };
}

/** 当前生效配置 = 环境变量默认值 + 管理页保存的覆盖项 */
export function getConfig(): AppConfig {
  const cfg = envDefaults();
  const rows = db
    .prepare("SELECT key, value FROM meta WHERE key LIKE 'cfg_%'")
    .all() as unknown as { key: string; value: string }[];
  for (const row of rows) {
    const field = String(row.key).slice(4) as keyof AppConfig;
    if (!(CONFIG_KEYS as readonly string[]).includes(field)) continue;
    const value = String(row.value);
    if (value) (cfg as unknown as Record<string, string>)[field] = value;
  }
  if (cfg.embeddingProvider !== "gateway") cfg.embeddingProvider = "ollama";
  return cfg;
}

/** 哪些字段当前被管理页覆盖了（用于界面区分"来自 .env"还是"页面设置"） */
export function overriddenKeys(): string[] {
  const rows = db
    .prepare("SELECT key FROM meta WHERE key LIKE 'cfg_%'")
    .all() as unknown as { key: string }[];
  return rows.map((r) => String(r.key).slice(4));
}

export function saveConfig(patch: Partial<AppConfig>): void {
  const defaults = envDefaults();
  const upsert = db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const remove = db.prepare("DELETE FROM meta WHERE key = ?");
  for (const key of CONFIG_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    const next = String(value).trim();
    // 与 .env 默认值相同就不存覆盖，这样「页面设置」标记只标真正改过的字段
    if (next === String(defaults[key])) remove.run(`cfg_${key}`);
    else upsert.run(`cfg_${key}`, next);
  }
}

/** 清空页面设置，回到 .env.local 的值 */
export function resetConfig(): void {
  db.prepare("DELETE FROM meta WHERE key LIKE 'cfg_%'").run();
}

/** 把密钥打码后给前端展示，避免真实密钥回传到浏览器 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return "••••••";
  return `${key.slice(0, 5)}••••••${key.slice(-4)}`;
}

// 多轮对话压缩：消息数超过该值时，把最早的部分压缩为摘要，保留最近 KEEP_RECENT 条原文
export const COMPRESS_THRESHOLD = 10;
export const KEEP_RECENT = 6;
