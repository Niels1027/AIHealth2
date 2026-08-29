"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, PlugZap, RotateCcw, Save } from "lucide-react";
import clsx from "clsx";

export interface Settings {
  aiBaseUrl: string;
  aiApiKey: string;
  chatModel: string;
  utilityModel: string;
  embeddingProvider: "ollama" | "gateway";
  ollamaBaseUrl: string;
  ollamaEmbedModel: string;
  gatewayEmbedModel: string;
}

interface TestResult {
  label: string;
  ok: boolean;
  detail: string;
  ms: number;
}

/** 管理页的模型配置：网关地址、密钥、各模型名称，保存后立即生效，无需重启 */
export function ModelSettings({ onSaved }: { onSaved: () => void }) {
  const [form, setForm] = useState<Settings | null>(null);
  const [initial, setInitial] = useState<Settings | null>(null);
  const [overridden, setOverridden] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState<"" | "save" | "test" | "models" | "reset">("");
  const [tests, setTests] = useState<TestResult[] | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings");
      const data = await res.json();
      setForm(data.settings);
      setInitial(data.settings);
      setOverridden(data.overridden ?? []);
    } catch {
      setNotice({ kind: "error", text: "读取当前设置失败" });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (patch: Partial<Settings>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setTests(null);
    setNotice(null);
  };

  const embeddingChanged =
    !!form &&
    !!initial &&
    (form.embeddingProvider !== initial.embeddingProvider ||
      form.ollamaEmbedModel !== initial.ollamaEmbedModel ||
      form.gatewayEmbedModel !== initial.gatewayEmbedModel);

  const fetchModels = async () => {
    if (!form) return;
    setBusy("models");
    setNotice(null);
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "models", aiBaseUrl: form.aiBaseUrl, aiApiKey: form.aiApiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "获取失败");
      setModels(data.models ?? []);
      setNotice({ kind: "ok", text: `网关上有 ${data.models.length} 个可用模型，已填入下拉列表` });
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : "获取模型列表失败" });
    } finally {
      setBusy("");
    }
  };

  const test = async () => {
    if (!form) return;
    setBusy("test");
    setTests(null);
    setNotice(null);
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, action: "full" }),
      });
      const data = await res.json();
      setTests(data.results ?? []);
    } catch {
      setNotice({ kind: "error", text: "测试请求失败" });
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    if (!form) return;
    setBusy("save");
    setNotice(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "保存失败");
      setForm(data.settings);
      setInitial(data.settings);
      setOverridden(data.overridden ?? []);
      setNotice({
        kind: "ok",
        text: embeddingChanged
          ? "已保存并立即生效。向量化设置有变动，请点上方「重建全部索引」，否则检索会报索引不匹配"
          : "已保存，立即生效，不需要重启服务",
      });
      onSaved();
    } catch (e) {
      setNotice({ kind: "error", text: e instanceof Error ? e.message : "保存失败" });
    } finally {
      setBusy("");
    }
  };

  const reset = async () => {
    if (!window.confirm("清空这里的设置，恢复成 .env.local 里的配置？")) return;
    setBusy("reset");
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetToEnv: true }),
      });
      await load();
      setTests(null);
      setNotice({ kind: "ok", text: "已恢复为 .env.local 中的配置" });
      onSaved();
    } finally {
      setBusy("");
    }
  };

  if (!form) {
    return (
      <section className="mt-5 rounded-2xl border border-line bg-card p-5">
        <h2 className="text-sm font-semibold">模型配置</h2>
        <p className="mt-3 flex items-center gap-2 text-sm text-faint">
          <Loader2 size={14} className="animate-spin" aria-hidden />
          读取中…
        </p>
      </section>
    );
  }

  return (
    <section className="mt-5 rounded-2xl border border-line bg-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">模型配置</h2>
        <p className="text-xs text-faint">保存后立即生效，无需重启服务</p>
      </div>

      {/* 网关 */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Field
          label="AI 网关地址"
          hint="OpenAI 兼容接口，通常以 /v1 结尾"
          overridden={overridden.includes("aiBaseUrl")}
        >
          <input
            value={form.aiBaseUrl}
            onChange={(e) => set({ aiBaseUrl: e.target.value })}
            placeholder="https://api.example.com/v1"
            className={inputCls}
            spellCheck={false}
          />
        </Field>
        <Field
          label="API 密钥"
          hint="留空表示不改动已保存的密钥"
          overridden={overridden.includes("aiApiKey")}
        >
          <input
            value={form.aiApiKey}
            onChange={(e) => set({ aiApiKey: e.target.value })}
            placeholder="sk-…"
            type="text"
            autoComplete="off"
            className={clsx(inputCls, "font-mono")}
            spellCheck={false}
          />
        </Field>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          label="回答模型"
          hint="用户提问时生成答案的主模型"
          overridden={overridden.includes("chatModel")}
        >
          <input
            value={form.chatModel}
            onChange={(e) => set({ chatModel: e.target.value })}
            list="hr-models"
            className={inputCls}
            spellCheck={false}
          />
        </Field>
        <Field
          label="辅助模型"
          hint="做追问改写和历史压缩，建议用便宜快速的模型"
          overridden={overridden.includes("utilityModel")}
        >
          <input
            value={form.utilityModel}
            onChange={(e) => set({ utilityModel: e.target.value })}
            list="hr-models"
            className={inputCls}
            spellCheck={false}
          />
        </Field>
      </div>
      <datalist id="hr-models">
        {models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <button
        type="button"
        onClick={fetchModels}
        disabled={!!busy}
        className="mt-2 text-xs text-moss underline-offset-2 hover:underline disabled:text-faint"
      >
        {busy === "models" ? "读取中…" : "不知道填什么？点这里拉取网关上的可用模型"}
      </button>

      {/* 向量化 */}
      <div className="mt-5 border-t border-line pt-4">
        <div className="text-xs text-faint">向量化方式（决定检索质量，改动后需要重建索引）</div>
        <div className="mt-2 flex gap-1 rounded-lg bg-paper p-0.5 text-xs" role="group">
          {(
            [
              ["ollama", "本地 Ollama（推荐）"],
              ["gateway", "AI 网关"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => set({ embeddingProvider: key })}
              className={clsx(
                "rounded-md px-3 py-1.5 transition-colors",
                form.embeddingProvider === key
                  ? "bg-card text-ink shadow-[0_1px_2px_rgba(31,39,37,0.08)]"
                  : "text-pen hover:text-ink"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {form.embeddingProvider === "ollama" ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field
              label="Ollama 地址"
              hint="本机默认即可"
              overridden={overridden.includes("ollamaBaseUrl")}
            >
              <input
                value={form.ollamaBaseUrl}
                onChange={(e) => set({ ollamaBaseUrl: e.target.value })}
                className={inputCls}
                spellCheck={false}
              />
            </Field>
            <Field
              label="向量模型"
              hint="需先在终端 ollama pull 下载"
              overridden={overridden.includes("ollamaEmbedModel")}
            >
              <input
                value={form.ollamaEmbedModel}
                onChange={(e) => set({ ollamaEmbedModel: e.target.value })}
                className={inputCls}
                spellCheck={false}
              />
            </Field>
          </div>
        ) : (
          <div className="mt-3">
            <Field
              label="网关向量模型"
              hint="需要网关已开通 embeddings 接口"
              overridden={overridden.includes("gatewayEmbedModel")}
            >
              <input
                value={form.gatewayEmbedModel}
                onChange={(e) => set({ gatewayEmbedModel: e.target.value })}
                className={inputCls}
                spellCheck={false}
              />
            </Field>
          </div>
        )}

        {embeddingChanged && (
          <p className="mt-2.5 flex items-start gap-1.5 text-xs text-warn">
            <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden />
            向量化设置有改动。保存后必须点上方「重建全部索引」重新生成向量，否则提问会报索引不匹配。
          </p>
        )}
      </div>

      {/* 操作 */}
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={test}
          disabled={!!busy}
          className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-sm text-pen transition-colors hover:border-moss/50 hover:text-moss disabled:text-faint"
        >
          {busy === "test" ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <PlugZap size={14} aria-hidden />
          )}
          测试连接
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!!busy}
          className="flex items-center gap-1.5 rounded-lg bg-moss px-4 py-2 text-sm text-white transition-colors hover:bg-moss-deep disabled:bg-line disabled:text-faint"
        >
          {busy === "save" ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Save size={14} aria-hidden />
          )}
          保存
        </button>
        <button
          type="button"
          onClick={reset}
          disabled={!!busy}
          className="ml-auto flex items-center gap-1.5 text-xs text-faint transition-colors hover:text-pen"
          title="清空页面设置，回到 .env.local 的配置"
        >
          <RotateCcw size={12} aria-hidden />
          恢复 .env 默认
        </button>
      </div>

      {tests && (
        <div className="mt-3 flex flex-col gap-1.5 rounded-lg border border-line bg-paper p-3">
          {tests.map((t) => (
            <div key={t.label} className="flex items-start gap-2 text-xs">
              {t.ok ? (
                <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-moss" aria-hidden />
              ) : (
                <AlertCircle size={13} className="mt-0.5 shrink-0 text-warn" aria-hidden />
              )}
              <span className="shrink-0 text-ink">{t.label}</span>
              <span className={clsx("min-w-0 flex-1", t.ok ? "text-pen" : "text-warn")}>
                {t.detail}
              </span>
              <span className="shrink-0 font-mono text-faint">{(t.ms / 1000).toFixed(1)}s</span>
            </div>
          ))}
        </div>
      )}

      {notice && (
        <p
          className={clsx(
            "mt-3 flex items-start gap-1.5 text-xs",
            notice.kind === "ok" ? "text-moss" : "text-warn"
          )}
        >
          {notice.kind === "ok" ? (
            <CheckCircle2 size={13} className="mt-0.5 shrink-0" aria-hidden />
          ) : (
            <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden />
          )}
          {notice.text}
        </p>
      )}
    </section>
  );
}

const inputCls =
  "w-full rounded-lg border border-line bg-paper px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-moss/50";

function Field({
  label,
  hint,
  overridden,
  children,
}: {
  label: string;
  hint?: string;
  overridden?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1.5 text-xs text-faint">
        {label}
        {overridden && (
          <span className="rounded bg-mist px-1 py-px text-[10px] text-moss-deep">页面设置</span>
        )}
      </span>
      <span className="mt-1 block">{children}</span>
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}
