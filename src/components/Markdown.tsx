"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 回答正文渲染：把 [1] 这样的引用编号转成可点击的小药丸，联动下方来源卡
export function AnswerMarkdown({
  content,
  onCite,
}: {
  content: string;
  onCite?: (n: number) => void;
}) {
  const processed = content
    // CommonMark 对 CJK 紧邻的 ** 不生效，这类加粗统一转成中文强调符号「」
    .replace(/\*\*([^*\n]+?)\*\*/g, (m, inner: string) =>
      /[一-鿿　-〿＀-￯]/.test(inner) ? `「${inner.trim()}」` : m
    )
    .replace(/\[(\d{1,2})\](?!\()/g, (_m, n) => `[${n}](#cite-${n})`);
  return (
    <div className="answer-prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            if (typeof href === "string" && href.startsWith("#cite-")) {
              const n = Number(href.slice(6));
              return (
                <button
                  type="button"
                  className="cite-pill"
                  onClick={() => onCite?.(n)}
                  aria-label={`查看来源 ${n}`}
                >
                  {children}
                </button>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-moss underline">
                {children}
              </a>
            );
          },
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  );
}
