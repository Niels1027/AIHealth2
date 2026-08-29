// 中文分词：用 Node 内置的 Intl.Segmenter（ICU），无需任何第三方分词库。
// 分词结果以空格连接后写入 FTS5，使默认 tokenizer 也能正确检索中文。

const segmenter = new Intl.Segmenter("zh-Hans", { granularity: "word" });

const STOPWORDS = new Set(
  `的 了 是 在 我 你 他 她 它 我们 你们 他们 这 那 这个 那个 这些 那些 和 与 或 就 都 而 及 着 也 很 太 更 最 到 说 要 去 会 能 可以 什么 怎么 怎样 如何 为什么 吗 呢 吧 啊 哪 哪些 请问 一下 有 没有 不 一个 一种 上 中 下 对 从 被 让 给 但 但是 因为 所以 如果 还是 还有 关于 应该 需要 想 知道 告诉 帮 请 书 书中 书里 这本 本书 作者 讲 提到 内容 意思 是什么 介绍`.split(/\s+/)
);

export function segmentText(text: string): string[] {
  const words: string[] = [];
  for (const s of segmenter.segment(text)) {
    if (!s.isWordLike) continue;
    const w = s.segment.trim().toLowerCase();
    if (w) words.push(w);
  }
  return words;
}

/** 入库用：分词后以空格连接 */
export function segmentForIndex(text: string): string {
  return segmentText(text).join(" ");
}

/** 查询用：去停用词、去重、转 FTS5 OR 查询串 */
export function buildFtsQuery(text: string): string {
  const words = [...new Set(segmentText(text))]
    .filter((w) => !STOPWORDS.has(w))
    .slice(0, 24);
  return words.map((w) => `"${w.replaceAll('"', "")}"`).join(" OR ");
}
