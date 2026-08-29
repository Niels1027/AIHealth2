import { getConfig } from "./config.ts";

// AI 网关客户端（OpenAI 兼容 /chat/completions），支持非流式与流式两种调用。

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatOptions {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 仅用于管理页「测试连接」：临时指定网关，不影响已保存配置 */
  baseUrl?: string;
  apiKey?: string;
}

function endpoint(opts: ChatOptions) {
  const cfg = getConfig();
  return {
    url: `${(opts.baseUrl ?? cfg.aiBaseUrl).replace(/\/+$/, "")}/chat/completions`,
    model: opts.model ?? cfg.chatModel,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey ?? cfg.aiApiKey}`,
    },
  };
}

export async function chatComplete(opts: ChatOptions): Promise<string> {
  const { url, model, headers } = endpoint(opts);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI 网关调用失败 (${res.status})：${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

/** 流式对话：逐 token 产出文本增量 */
export async function* chatStream(opts: ChatOptions): AsyncGenerator<string> {
  const { url, model, headers } = endpoint(opts);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: opts.messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      stream: true,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`AI 网关调用失败 (${res.status})：${body.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        // 忽略无法解析的行
      }
    }
  }
}

/** 拉取网关上可用的模型列表（OpenAI 兼容 /models），供管理页下拉选择 */
export async function listGatewayModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`获取模型列表失败 (${res.status})：${body.slice(0, 160)}`);
  }
  const data = (await res.json()) as { data?: { id?: string }[] };
  return (data.data ?? [])
    .map((m) => String(m.id ?? ""))
    .filter(Boolean)
    .sort();
}
