"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ClipboardPaste,
  FileText,
  Loader2,
  RefreshCw,
  Trash2,
  UploadCloud,
} from "lucide-react";
import clsx from "clsx";
import { timeAgo, useRole } from "./shared";
import { ModelSettings } from "./ModelSettings";

interface DocRow {
  id: number;
  title: string;
  source: string;
  status: "processing" | "ready" | "error";
  progress: number;
  chunk_count: number;
  char_count: number;
  error: string | null;
  created_at: string;
}

interface Health {
  embedding: { ok: boolean; provider: string; model: string; dim?: number; error?: string };
  chat: { model: string; utilityModel: string; keyPresent: boolean };
  indexSignature: string | null;
  stats: {
    documents: number;
    chunks: number;
    embeddedChunks: number;
    conversations: number;
  };
}

export default function AdminPanel() {
  const [role, setRole] = useRole();
  const [health, setHealth] = useState<Health | null>(null);
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [tab, setTab] = useState<"file" | "paste">("file");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadDocs = useCallback(async () => {
    try {
      const res = await fetch("/api/documents");
      const data = await res.json();
      setDocs(data.documents ?? []);
    } catch {
      // 保持上次数据
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
    loadDocs();
    loadHealth();
    const t1 = setInterval(loadDocs, 2500);
    const t2 = setInterval(loadHealth, 10_000);
    return () => {
      clearInterval(t1);
      clearInterval(t2);
    };
  }, [loadDocs, loadHealth]);

  const submit = async () => {
    if (uploading) return;
    setNotice(null);
    setUploading(true);
    try {
      let res: Response;
      if (tab === "file") {
        if (!file) throw new Error("请先选择文件");
        const form = new FormData();
        form.append("file", file);
        if (title.trim()) form.append("title", title.trim());
        res = await fetch("/api/documents", { method: "POST", body: form });
      } else {
        if (!text.trim()) throw new Error("请先粘贴文本内容");
        res = await fetch("/api/documents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: title.trim(), text }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "上传失败");
      setNotice({ kind: "ok", text: "已导入，正在分块与向量化，可在下方列表查看进度" });
      setFile(null);
      setTitle("");
      setText("");
      if (fileInput.current) fileInput.current.value = "";
      loadDocs();
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : "上传失败" });
    } finally {
      setUploading(false);
    }
  };

  const removeDoc = async (d: DocRow) => {
    if (!window.confirm(`删除「${d.title}」及其全部索引？`)) return;
    await fetch(`/api/documents/${d.id}`, { method: "DELETE" });
    loadDocs();
    loadHealth();
  };

  const retryDoc = async (d: DocRow) => {
    await fetch(`/api/documents/${d.id}/reprocess`, { method: "POST" });
    loadDocs();
  };

  const reindex = async () => {
    if (
      !window.confirm(
        "将清空全部向量索引，并用当前 embedding 配置重新生成（更换模型后使用）。继续？"
      )
    )
      return;
    const res = await fetch("/api/reindex", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) setNotice({ kind: "error", text: data.error || "重建索引失败" });
    loadDocs();
    loadHealth();
  };

  if (role !== "admin") {
    return (
      <Shell>
        <div className="mx-auto mt-24 max-w-sm rounded-2xl border border-line bg-card p-6 text-center">
          <p className="text-sm text-pen">知识库管理需要管理员身份</p>
          <button
            type="button"
            onClick={() => setRole("admin")}
            className="mt-4 rounded-lg bg-moss px-4 py-2 text-sm text-white hover:bg-moss-deep"
          >
            切换为管理员
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mx-auto max-w-3xl px-4 pb-16">
        {/* 运行状态 */}
        <section className="mt-6 rounded-2xl border border-line bg-card p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">运行状态</h2>
            <button
              type="button"
              onClick={reindex}
              className="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-pen hover:border-moss/50 hover:text-moss"
              title="更换 embedding 模型后，用当前配置重新生成全部向量"
            >
              <RefreshCw size={12} aria-hidden />
              重建全部索引
            </button>
          </div>
          <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <StatusRow
              label="向量化（Embedding）"
              ok={health?.embedding.ok}
              value={
                health
                  ? `${health.embedding.provider === "ollama" ? "本地 Ollama" : "AI 网关"} · ${health.embedding.model}${health.embedding.dim ? ` · ${health.embedding.dim} 维` : ""}`
                  : "…"
              }
              detail={health?.embedding.error}
            />
            <StatusRow
              label="回答模型"
              ok={health ? health.chat.keyPresent : undefined}
              value={health ? `${health.chat.model} · 辅助 ${health.chat.utilityModel}` : "…"}
              detail={health && !health.chat.keyPresent ? "缺少 AI_API_KEY" : undefined}
            />
            <div>
              <dt className="text-xs text-faint">知识库</dt>
              <dd className="mt-0.5 font-mono text-[13px]">
                {health
                  ? `${health.stats.documents} 文档 · ${health.stats.embeddedChunks}/${health.stats.chunks} 段落已索引`
                  : "…"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-faint">索引签名</dt>
              <dd className="mt-0.5 truncate font-mono text-[13px]" title={health?.indexSignature ?? ""}>
                {health?.indexSignature ?? "（尚未建立索引）"}
              </dd>
            </div>
          </dl>
        </section>

        {/* 模型配置 */}
        <ModelSettings onSaved={loadHealth} />

        {/* 导入内容 */}
        <section className="mt-5 rounded-2xl border border-line bg-card p-5">
          <h2 className="text-sm font-semibold">导入内容</h2>
          <div className="mt-3 flex gap-1 rounded-lg bg-paper p-0.5 text-xs" role="tablist">
            {(
              [
                ["file", "上传文件", FileText],
                ["paste", "粘贴文本", ClipboardPaste],
              ] as const
            ).map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className={clsx(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 transition-colors",
                  tab === key ? "bg-card text-ink shadow-[0_1px_2px_rgba(31,39,37,0.08)]" : "text-pen"
                )}
              >
                <Icon size={13} aria-hidden />
                {label}
              </button>
            ))}
          </div>

          <div className="mt-4">
            {tab === "file" ? (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files?.[0];
                  if (f) setFile(f);
                }}
                className={clsx(
                  "flex w-full flex-col items-center justify-center rounded-xl border border-dashed px-4 py-8 text-sm transition-colors",
                  dragging ? "border-moss bg-mist/60" : "border-line hover:border-moss/50"
                )}
              >
                <UploadCloud size={22} className="text-faint" aria-hidden />
                {file ? (
                  <span className="mt-2 text-ink">{file.name}</span>
                ) : (
                  <>
                    <span className="mt-2 text-pen">点击选择或拖入文件</span>
                    <span className="mt-1 text-xs text-faint">支持 .txt / .md / .docx / .epub</span>
                  </>
                )}
              </button>
            ) : (
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={8}
                placeholder="把书籍章节或文本内容粘贴到这里…"
                className="w-full resize-y rounded-xl border border-line bg-paper px-3.5 py-3 text-sm leading-relaxed outline-none placeholder:text-faint focus:border-moss/50"
              />
            )}
            <input
              ref={fileInput}
              type="file"
              accept=".txt,.md,.markdown,.docx,.epub"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
            <div className="mt-3 flex items-center gap-2">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={tab === "file" ? "标题（留空则用文件名）" : "标题，如：超越百岁"}
                className="w-56 rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-moss/50"
              />
              <button
                type="button"
                onClick={submit}
                disabled={uploading}
                className="flex items-center gap-1.5 rounded-lg bg-moss px-4 py-2 text-sm text-white transition-colors hover:bg-moss-deep disabled:bg-line disabled:text-faint"
              >
                {uploading && <Loader2 size={13} className="animate-spin" aria-hidden />}
                导入并向量化
              </button>
            </div>
            {notice && (
              <p
                className={clsx(
                  "mt-3 flex items-center gap-1.5 text-xs",
                  notice.kind === "ok" ? "text-moss" : "text-warn"
                )}
              >
                {notice.kind === "ok" ? (
                  <CheckCircle2 size={13} aria-hidden />
                ) : (
                  <AlertCircle size={13} aria-hidden />
                )}
                {notice.text}
              </p>
            )}
          </div>
        </section>

        {/* 文档列表 */}
        <section className="mt-5 rounded-2xl border border-line bg-card p-5">
          <h2 className="text-sm font-semibold">已导入文档</h2>
          {docs.length === 0 ? (
            <p className="mt-4 text-sm text-faint">
              知识库还是空的 — 上传《超越百岁》的文本文件，或直接粘贴内容。
            </p>
          ) : (
            <div className="mt-3 divide-y divide-line">
              {docs.map((d) => (
                <div key={d.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-song truncate text-[15px]">{d.title}</span>
                      <span className="shrink-0 rounded bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase text-faint">
                        {d.source}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-faint">
                      {d.chunk_count} 个段落 · {formatChars(d.char_count)} · {timeAgo(d.created_at)}
                    </div>
                  </div>
                  <DocStatus doc={d} onRetry={() => retryDoc(d)} />
                  <button
                    type="button"
                    onClick={() => removeDoc(d)}
                    className="shrink-0 rounded-md p-1.5 text-faint transition-colors hover:text-warn"
                    aria-label={`删除 ${d.title}`}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3.5">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-sm text-pen transition-colors hover:text-moss"
          >
            <ArrowLeft size={15} aria-hidden />
            返回问答
          </Link>
          <span className="text-line">/</span>
          <h1 className="font-song text-[15px] font-semibold">知识库管理</h1>
        </div>
      </header>
      {children}
    </div>
  );
}

function StatusRow({
  label,
  ok,
  value,
  detail,
}: {
  label: string;
  ok?: boolean;
  value: string;
  detail?: string | null;
}) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="mt-0.5 flex items-start gap-1.5 text-[13px]">
        <span
          className={clsx(
            "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
            ok === undefined ? "bg-faint" : ok ? "bg-moss" : "bg-warn"
          )}
          aria-hidden
        />
        <span className="min-w-0">
          <span className="font-mono">{value}</span>
          {detail && <span className="mt-0.5 block text-xs text-warn">{detail}</span>}
        </span>
      </dd>
    </div>
  );
}

function DocStatus({ doc, onRetry }: { doc: DocRow; onRetry: () => void }) {
  if (doc.status === "ready") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs text-moss">
        <CheckCircle2 size={13} aria-hidden />
        就绪
      </span>
    );
  }
  if (doc.status === "error") {
    return (
      <span className="flex shrink-0 items-center gap-2 text-xs text-warn" title={doc.error ?? ""}>
        <AlertCircle size={13} aria-hidden />
        失败
        <button type="button" onClick={onRetry} className="underline">
          重试
        </button>
      </span>
    );
  }
  const pct = Math.round(doc.progress * 100);
  return (
    <span className="flex w-28 shrink-0 flex-col gap-1 text-xs text-pen">
      <span className="flex items-center gap-1">
        <Loader2 size={12} className="animate-spin" aria-hidden />
        处理中 {pct}%
        <button
          type="button"
          onClick={onRetry}
          className="text-faint underline"
          title="如进度长时间不动，点此从断点恢复"
        >
          恢复
        </button>
      </span>
      <span className="h-1 overflow-hidden rounded-full bg-line">
        <span className="block h-full rounded-full bg-moss transition-all" style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

function formatChars(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`;
}
