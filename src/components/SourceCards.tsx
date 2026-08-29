"use client";

import { BookOpen, ChevronDown } from "lucide-react";
import clsx from "clsx";
import type { SourceItem } from "./shared";

// 签名元素：章节来源卡。宋体章节名 + 可展开原文，与回答中的 [n] 引用联动。
export function SourceCards({
  sources,
  openIndex,
  onToggle,
}: {
  sources: SourceItem[];
  openIndex: number | null;
  onToggle: (n: number | null) => void;
}) {
  if (!sources.length) return null;
  return (
    <div className="mt-3 border-t border-line pt-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-faint">
        <BookOpen size={12} aria-hidden />
        引用原文 {sources.length} 处
      </div>
      <div className="flex flex-col gap-1.5">
        {sources.map((s) => {
          const open = openIndex === s.index;
          return (
            <div
              key={s.index}
              id={`src-${s.index}`}
              className={clsx(
                "rounded-lg border bg-card transition-colors",
                open ? "border-moss/40" : "border-line"
              )}
            >
              <button
                type="button"
                onClick={() => onToggle(open ? null : s.index)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
                aria-expanded={open}
              >
                <span className="cite-pill shrink-0">{s.index}</span>
                <span className="font-song truncate text-[13px] text-ink">
                  {s.chapter || s.docTitle}
                </span>
                {s.chapter && (
                  <span className="hidden truncate text-[11px] text-faint sm:inline">
                    {s.docTitle}
                  </span>
                )}
                <ChevronDown
                  size={14}
                  className={clsx(
                    "ml-auto shrink-0 text-faint transition-transform",
                    open && "rotate-180"
                  )}
                  aria-hidden
                />
              </button>
              {open && (
                <p className="whitespace-pre-wrap px-3 pb-2.5 pt-0.5 text-[13px] leading-relaxed text-pen">
                  {s.content}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
