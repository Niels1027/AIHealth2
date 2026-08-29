"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Database,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import clsx from "clsx";
import { AnswerMarkdown } from "./Markdown";
import { SourceCards } from "./SourceCards";
import { consumeSSE, timeAgo, useRole, type SourceItem } from "./shared";

interface Msg {
  role: "user" | "assistant";
  content: string;
  sources?: SourceItem[] | null;
  streaming?: boolean;
  error?: string | null;
  rewritten?: string;
}

interface ConvItem {
  id: number;
  title: string;
  updated_at: string;
  msg_count: number;
}

interface Health {
  embedding: { ok: boolean; provider: string; model: string; error?: string };
  stats: { chunks: number; embeddedChunks: number; readyDocuments: number };
}

const SAMPLE_QUESTIONS = [
  "什么是 Zone 2 训练？为什么它对长寿重要？",
  "如何降低 ApoB 和心血管疾病风险？",
  "书里怎么讲改善睡眠质量的方法？",
  "衰老过程中怎样保持肌肉量？",
];

export default function ChatApp() {
  const [role, setRole] = useRole();
  const [convs, setConvs] = useState<ConvItem[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastUserText = useRef("");

  const loadConvs = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      const data = await res.json();
      setConvs(data.conversations ?? []);
    } catch {
      // 列表加载失败不阻塞聊天
    }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      setHealth(await res.json());
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    loadConvs();
    loadHealth();
    const t = setInterval(loadHealth, 30_000);
    return () => clearInterval(t);
  }, [loadConvs, loadHealth]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setInput("");
    textareaRef.current?.focus();
  };

  const openConv = async (id: number) => {
    if (busy) return;
    try {
      const res = await fetch(`/api/conversations/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      setActiveId(id);
      setMessages(
        (data.messages ?? []).map(
          (m: { role: "user" | "assistant"; content: string; sources: SourceItem[] | null }) => ({
            role: m.role,
            content: m.content,
            sources: m.sources,
          })
        )
      );
    } catch {
      // 打开失败保持现状
    }
  };

  const deleteConv = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm("删除这个对话？")) return;
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (id === activeId) newChat();
    loadConvs();
  };

  const patchLast = (patch: Partial<Msg> | ((m: Msg) => Msg)) => {
    setMessages((prev) => {
      if (!prev.length) return prev;
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = typeof patch === "function" ? patch(last) : { ...last, ...patch };
      return next;
    });
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    lastUserText.current = text;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setBusy(true);
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "", streaming: true },
    ]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, message: text }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `请求失败 (${res.status})`);
      }
      await consumeSSE(res, (evt) => {
        switch (evt.type) {
          case "conversation":
            setActiveId(Number(evt.id));
            break;
          case "rewritten":
            patchLast({ rewritten: String(evt.query) });
            break;
          case "sources":
            patchLast({ sources: evt.sources as SourceItem[] });
            break;
          case "delta":
            patchLast((m) => ({ ...m, content: m.content + String(evt.text) }));
            break;
          case "error":
            patchLast({ error: String(evt.message), streaming: false });
            break;
          case "done":
            patchLast({ streaming: false });
            break;
        }
      });
      patchLast((m) => ({ ...m, streaming: false }));
    } catch (e) {
      patchLast({
        error: e instanceof Error ? e.message : "网络异常，请重试",
        streaming: false,
      });
    } finally {
      setBusy(false);
      loadConvs();
    }
  };

  const retry = () => {
    if (!lastUserText.current || busy) return;
    // 移除失败的回答与对应提问，重新发送
    setMessages((prev) => prev.slice(0, -2));
    void send(lastUserText.current);
  };

  const kbReady = !!health && health.stats.embeddedChunks > 0 && health.embedding.ok;
  const statusText = !health
    ? "状态获取中…"
    : !health.embedding.ok
      ? "本地向量服务未启动"
      : health.stats.chunks === 0
        ? "知识库为空"
        : health.stats.embeddedChunks < health.stats.chunks
          ? "知识库处理中…"
          : `知识库就绪 · ${health.stats.embeddedChunks} 个段落`;

  return (
    <div className="flex h-dvh">
      {/* 侧栏 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-card/70 max-md:hidden">
        <div className="px-4 pb-3 pt-5">
          <div className="font-song text-lg font-semibold tracking-wide">健康问书</div>
          <div className="mt-0.5 text-xs text-faint">书籍知识库 · 健康问答</div>
        </div>
        <div className="px-3">
          <button
            type="button"
            onClick={newChat}
            className="flex w-full items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink transition-colors hover:border-moss/50 hover:text-moss"
          >
            <Plus size={15} aria-hidden />
            新对话
          </button>
        </div>
        <nav className="mt-3 flex-1 overflow-y-auto px-3" aria-label="历史对话">
          {convs.map((c) => (
            <div
              key={c.id}
              onClick={() => openConv(c.id)}
              className={clsx(
                "group mb-0.5 flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm",
                c.id === activeId ? "bg-mist text-moss-deep" : "text-pen hover:bg-mist/60"
              )}
            >
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <span className="shrink-0 text-[11px] text-faint group-hover:hidden">
                {timeAgo(c.updated_at)}
              </span>
              <button
                type="button"
                onClick={(e) => deleteConv(c.id, e)}
                className="hidden shrink-0 text-faint hover:text-warn group-hover:block"
                aria-label="删除对话"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {!convs.length && (
            <p className="px-3 py-2 text-xs text-faint">还没有历史对话</p>
          )}
        </nav>
        <div className="border-t border-line p-3">
          <div className="mb-2.5 flex items-center gap-2 px-1 text-xs text-pen">
            <span
              className={clsx(
                "h-1.5 w-1.5 rounded-full",
                kbReady ? "bg-moss" : health?.embedding.ok === false ? "bg-warn" : "bg-faint"
              )}
              aria-hidden
            />
            {statusText}
          </div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex rounded-full border border-line bg-paper p-0.5 text-xs" role="group" aria-label="身份切换">
              {(["user", "admin"] as const).map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRole(r)}
                  className={clsx(
                    "rounded-full px-2.5 py-1 transition-colors",
                    role === r ? "bg-moss text-white" : "text-pen hover:text-ink"
                  )}
                >
                  {r === "user" ? "用户" : "管理员"}
                </button>
              ))}
            </div>
            {role === "admin" && (
              <Link
                href="/admin"
                className="flex items-center gap-1 text-xs text-moss hover:text-moss-deep"
              >
                <Database size={13} aria-hidden />
                知识库
              </Link>
            )}
          </div>
        </div>
      </aside>

      {/* 主区域 */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏 */}
        <div className="flex items-center justify-between border-b border-line px-4 py-3 md:hidden">
          <span className="font-song font-semibold">健康问书</span>
          <div className="flex items-center gap-3">
            {role === "admin" && (
              <Link href="/admin" className="text-xs text-moss">
                知识库
              </Link>
            )}
            <button type="button" onClick={newChat} className="text-pen" aria-label="新对话">
              <Plus size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-4 py-6">
            {messages.length === 0 ? (
              <EmptyState onAsk={(q) => send(q)} kbReady={kbReady} />
            ) : (
              <div className="flex flex-col gap-6">
                {messages.map((m, i) => (
                  <MessageView key={i} msg={m} onRetry={retry} />
                ))}
                <div ref={bottomRef} />
              </div>
            )}
          </div>
        </div>

        <div className="mx-auto w-full max-w-2xl px-4 pb-4">
          <div className="flex items-end gap-2 rounded-2xl border border-line bg-card p-2 shadow-[0_1px_3px_rgba(31,39,37,0.04)] focus-within:border-moss/50">
            <textarea
              ref={textareaRef}
              value={input}
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="问一个关于健康与长寿的问题…"
              className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-relaxed outline-none placeholder:text-faint"
              aria-label="输入问题"
            />
            <button
              type="button"
              onClick={() => send()}
              disabled={busy || !input.trim()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-moss text-white transition-colors hover:bg-moss-deep disabled:bg-line disabled:text-faint"
              aria-label="发送"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-faint">
            回答内容整理自已导入书籍，仅供参考，不构成医疗建议
          </p>
        </div>
      </main>
    </div>
  );
}

function EmptyState({ onAsk, kbReady }: { onAsk: (q: string) => void; kbReady: boolean }) {
  return (
    <div className="flex flex-col items-center pt-[14vh] text-center">
      <h1 className="font-song text-3xl font-semibold tracking-[0.08em]">健康问书</h1>
      <p className="mt-3 text-sm text-pen">基于《超越百岁》等书籍原文回答，每个结论都可溯源</p>
      <div className="mt-10 grid w-full gap-2 sm:grid-cols-2">
        {SAMPLE_QUESTIONS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => onAsk(q)}
            className="rounded-xl border border-line bg-card px-4 py-3 text-left text-[13px] leading-relaxed text-pen transition-colors hover:border-moss/50 hover:text-moss-deep"
          >
            {q}
          </button>
        ))}
      </div>
      {!kbReady && (
        <p className="mt-8 text-xs text-faint">
          知识库尚未就绪 — 管理员可在「知识库管理」中导入书籍内容
        </p>
      )}
    </div>
  );
}

function MessageView({ msg, onRetry }: { msg: Msg; onRetry: () => void }) {
  const [openSrc, setOpenSrc] = useState<number | null>(null);

  if (msg.role === "user") {
    return (
      <div className="msg-enter flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-mist px-4 py-2.5 text-[15px] leading-relaxed text-ink">
          {msg.content}
        </div>
      </div>
    );
  }

  const searching = msg.streaming && !msg.content;
  return (
    <div className="msg-enter">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-moss" aria-hidden />
        <span className="text-xs text-faint">健康问书</span>
        {msg.rewritten && (
          <span className="truncate text-[11px] text-faint">检索「{msg.rewritten}」</span>
        )}
      </div>
      {msg.error ? (
        <div className="rounded-lg border border-warn/30 bg-warn/5 px-3.5 py-2.5 text-sm text-warn">
          {msg.error}
          <button
            type="button"
            onClick={onRetry}
            className="ml-3 inline-flex items-center gap-1 text-xs underline"
          >
            <RefreshCw size={11} aria-hidden />
            重试
          </button>
        </div>
      ) : searching ? (
        <p className="flex items-center gap-2 text-sm text-faint">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          {msg.sources?.length
            ? `找到 ${msg.sources.length} 处相关原文，正在组织回答…`
            : "正在检索书籍内容…"}
        </p>
      ) : (
        <>
          <AnswerMarkdown content={msg.content} onCite={(n) => setOpenSrc(n)} />
          {msg.streaming && <span className="stream-caret" aria-hidden />}
          {!!msg.sources?.length && !msg.streaming && (
            <SourceCards sources={msg.sources} openIndex={openSrc} onToggle={setOpenSrc} />
          )}
        </>
      )}
    </div>
  );
}
