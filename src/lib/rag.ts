import { chatComplete, type ChatMessage } from "./ai.ts";
import { COMPRESS_THRESHOLD, KEEP_RECENT, getConfig } from "./config.ts";
import { db, now } from "./db.ts";
import type { RetrievedChunk } from "./retrieval.ts";

export interface MessageRow {
  id: number;
  conv_id: number;
  role: "user" | "assistant";
  content: string;
  sources: string | null;
  created_at: string;
}

export function getMessages(convId: number): MessageRow[] {
  return db
    .prepare("SELECT * FROM messages WHERE conv_id = ? ORDER BY id ASC")
    .all(convId) as unknown as MessageRow[];
}

/** 多轮改写：把依赖上下文的追问改写成独立可检索的问题 */
export async function rewriteQuery(history: MessageRow[], question: string): Promise<string> {
  if (!history.length) return question;
  const recent = history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 400)}`)
    .join("\n");
  try {
    const rewritten = await chatComplete({
      model: getConfig().utilityModel,
      temperature: 0,
      maxTokens: 200,
      messages: [
        {
          role: "system",
          content:
            "你负责改写检索查询。根据对话历史，把用户的最新问题改写成一个独立、完整、无需上下文即可理解的中文检索问题，保留专有名词。只输出改写后的问题本身，不要任何解释或引号。如果最新问题本身已经独立完整，原样输出。",
        },
        { role: "user", content: `对话历史：\n${recent}\n\n最新问题：${question}` },
      ],
    });
    const clean = rewritten.trim().replace(/^["'「『]|["'」』]$/g, "");
    return clean && clean.length <= 200 ? clean : question;
  } catch {
    return question;
  }
}

export function buildContextBlock(sources: RetrievedChunk[]): string {
  if (!sources.length) return "【参考资料】\n（本次检索没有找到相关内容）";
  const parts = sources.map((s, i) => {
    const loc = [s.docTitle, s.chapter].filter(Boolean).join(" · ");
    return `[${i + 1}]（${loc}）\n${s.content}`;
  });
  return `【参考资料】\n${parts.join("\n\n")}`;
}

export function systemPrompt(docTitles: string[]): string {
  const kb = docTitles.length ? `《${docTitles.join("》《")}》` : "（暂无文档）";
  return `你是一个健康知识问答助手，基于已导入的书籍知识库回答问题。当前知识库文档：${kb}。

回答结构（每次都要遵守）：
1. 第一行只写「祝你健康」四个字，单独成段，作为开场问候。
2. 紧接着用一到两句话直接给出结论，让读者第一时间拿到答案，不要铺垫。
3. 之后再分点展开理由、细节和书中依据。
4. 展开部分的小标题要用内容本身来命名（例如「书里的具体温度建议」），不要出现「结论」「展开」「先说结论」这类描述结构的字眼，也不要重复已经说过的结论。

语气：
5. 温柔、耐心，像一位懂行又体贴的朋友在娓娓道来。用平和的措辞，不用命令式或说教口吻。
6. 遇到用户可能担心的健康问题，先安抚情绪再讲事实；给建议时说"可以试试""不妨"，而不是"你必须""你应该"。

内容准则：
7. 只依据本轮提供的【参考资料】回答。资料中没有涉及的内容，温和地说明书里没有讲到这部分，绝不凭自己的知识编造或补充答案。
8. 用简体中文回答，面向普通读者，表达清晰、简洁，优先使用短段落和列表。不要使用 Markdown 加粗语法（**），需要强调时用「」标注。
9. 引用具体资料的句子后面用 [1][2] 这样的编号标注来源。
10. 涉及疾病诊断、用药剂量、治疗方案的问题，在回答末尾温和地提醒用户咨询专业医生。
11. 如果参考资料与问题只是弱相关，先回答能回答的部分，并说明书中没有完全覆盖这个问题。`;
}

export interface ConversationContext {
  summary: string;
  recent: MessageRow[];
}

/** 取对话上下文：滚动摘要 + 未被摘要覆盖的近期消息 */
export function getConversationContext(convId: number): ConversationContext {
  const conv = db
    .prepare("SELECT summary, summarized_upto FROM conversations WHERE id = ?")
    .get(convId) as unknown as { summary: string; summarized_upto: number } | undefined;
  if (!conv) return { summary: "", recent: [] };
  const recent = db
    .prepare("SELECT * FROM messages WHERE conv_id = ? AND id > ? ORDER BY id ASC")
    .all(convId, Number(conv.summarized_upto)) as unknown as MessageRow[];
  return { summary: conv.summary ?? "", recent };
}

export function contextToChatMessages(ctx: ConversationContext): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  if (ctx.summary) {
    msgs.push({ role: "system", content: `此前对话的背景摘要：${ctx.summary}` });
  }
  for (const m of ctx.recent) {
    msgs.push({ role: m.role, content: m.content });
  }
  return msgs;
}

/** 超过阈值时把较早消息压缩进滚动摘要，只保留最近 KEEP_RECENT 条原文 */
export async function compressIfNeeded(convId: number): Promise<void> {
  const conv = db
    .prepare("SELECT summary, summarized_upto FROM conversations WHERE id = ?")
    .get(convId) as unknown as { summary: string; summarized_upto: number } | undefined;
  if (!conv) return;
  const unsummarized = db
    .prepare("SELECT * FROM messages WHERE conv_id = ? AND id > ? ORDER BY id ASC")
    .all(convId, Number(conv.summarized_upto)) as unknown as MessageRow[];
  if (unsummarized.length <= COMPRESS_THRESHOLD) return;

  const toCompress = unsummarized.slice(0, unsummarized.length - KEEP_RECENT);
  if (!toCompress.length) return;
  const transcript = toCompress
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.slice(0, 500)}`)
    .join("\n");
  try {
    const summary = await chatComplete({
      model: getConfig().utilityModel,
      temperature: 0,
      maxTokens: 400,
      messages: [
        {
          role: "system",
          content:
            "你负责压缩对话历史。把已有摘要与新增对话合并成一段简洁的中文备忘摘要（250字以内），保留：用户关注的健康主题、用户提到的个人情况、已经给出的关键结论。只输出摘要本身。",
        },
        {
          role: "user",
          content: `已有摘要：${conv.summary || "（无）"}\n\n新增对话：\n${transcript}`,
        },
      ],
    });
    const upto = toCompress[toCompress.length - 1].id;
    db.prepare(
      "UPDATE conversations SET summary = ?, summarized_upto = ?, updated_at = ? WHERE id = ?"
    ).run(summary.trim().slice(0, 1000), upto, now(), convId);
  } catch {
    // 压缩失败不影响主流程，下轮再试
  }
}
