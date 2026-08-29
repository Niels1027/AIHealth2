import { NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { db, now } from "@/lib/db";
import { chatStream } from "@/lib/ai";
import { hasIndexedChunks, retrieve } from "@/lib/retrieval";
import {
  buildContextBlock,
  compressIfNeeded,
  contextToChatMessages,
  getConversationContext,
  rewriteQuery,
  systemPrompt,
} from "@/lib/rag";
import type { ChatMessage } from "@/lib/ai";

export const dynamic = "force-dynamic";

interface ChatBody {
  conversationId?: number;
  message?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as ChatBody;
  const message = String(body.message ?? "").trim();
  if (!message) {
    return Response.json({ error: "消息不能为空" }, { status: 400 });
  }
  if (message.length > 2000) {
    return Response.json({ error: "单条消息请控制在 2000 字以内" }, { status: 400 });
  }

  // 找到或创建对话
  let convId = Number(body.conversationId) || 0;
  const t = now();
  if (convId) {
    const exists = db.prepare("SELECT id FROM conversations WHERE id = ?").get(convId);
    if (!exists) convId = 0;
  }
  if (!convId) {
    const res = db
      .prepare("INSERT INTO conversations(title, created_at, updated_at) VALUES(?, ?, ?)")
      .run(message.slice(0, 24), t, t);
    convId = Number(res.lastInsertRowid);
  } else {
    // 首条消息时把默认标题替换为问题内容
    db.prepare(
      "UPDATE conversations SET title = CASE WHEN title = '新对话' THEN ? ELSE title END, updated_at = ? WHERE id = ?"
    ).run(message.slice(0, 24), t, convId);
  }

  // 先取上下文（不含本条），再落库本条用户消息
  const ctx = getConversationContext(convId);
  db.prepare("INSERT INTO messages(conv_id, role, content, created_at) VALUES(?, 'user', ?, ?)").run(
    convId,
    message,
    t
  );

  const encoder = new TextEncoder();
  const finalConvId = convId;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        } catch {
          // 客户端断开
        }
      };
      const saveAssistant = (content: string, sources: unknown | null) => {
        const res = db
          .prepare(
            "INSERT INTO messages(conv_id, role, content, sources, created_at) VALUES(?, 'assistant', ?, ?, ?)"
          )
          .run(finalConvId, content, sources ? JSON.stringify(sources) : null, now());
        db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), finalConvId);
        return Number(res.lastInsertRowid);
      };

      try {
        send({ type: "conversation", id: finalConvId });

        // 知识库为空时直接提示，不消耗模型调用
        if (!hasIndexedChunks()) {
          const tip =
            "知识库目前还没有可用内容。请管理员先在「知识库管理」中上传书籍文本（如《超越百岁》），完成向量化后即可提问。";
          send({ type: "delta", text: tip });
          const mid = saveAssistant(tip, null);
          send({ type: "done", messageId: mid });
          return;
        }

        // 1) 多轮改写
        const standalone = await rewriteQuery(ctx.recent, message);
        if (standalone !== message) send({ type: "rewritten", query: standalone });

        // 2) 混合检索
        const { results } = await retrieve(standalone, 8);
        send({
          type: "sources",
          sources: results.map((s, i) => ({
            index: i + 1,
            chunkId: s.chunkId,
            docTitle: s.docTitle,
            chapter: s.chapter,
            content: s.content,
          })),
        });

        // 3) 组装并流式生成
        const docTitles = (
          db.prepare("SELECT title FROM documents WHERE status = 'ready'").all() as unknown as {
            title: string;
          }[]
        ).map((d) => d.title);
        const messages: ChatMessage[] = [
          { role: "system", content: systemPrompt(docTitles) },
          ...contextToChatMessages(ctx),
          { role: "user", content: `${message}\n\n${buildContextBlock(results)}` },
        ];

        let full = "";
        for await (const token of chatStream({ model: getConfig().chatModel, messages })) {
          full += token;
          send({ type: "delta", text: token });
        }
        if (!full.trim()) throw new Error("模型没有返回内容，请重试");

        const mid = saveAssistant(full, results.length ? results : null);
        send({ type: "done", messageId: mid });

        // 4) 超过阈值时后台压缩历史
        void compressIfNeeded(finalConvId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "生成回答时出错";
        send({ type: "error", message: msg });
      } finally {
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
