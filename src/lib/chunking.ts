// 结构感知分块：先按章节标题切分，再在章节内按句子边界打包成 chunk。

export interface Section {
  chapter: string;
  text: string;
}

export interface ChunkDraft {
  chapter: string;
  seq: number;
  content: string;
}

const CN_NUM = "[0-9〇一二三四五六七八九十百千两]+";
const CHAPTER_PATTERNS = [
  new RegExp(`^第\\s*${CN_NUM}\\s*[章节讲部篇课](?:[\\s:：·、.]|$)`),
  /^(?:Chapter|CHAPTER)\s+\d+/,
  /^(?:序章|序言|前言|引言|导言|导读|后记|结语|附录|译者序|推荐序)(?:[\s:：]|$)/,
];

function isChapterLine(line: string): boolean {
  if (line.length > 48) return false;
  if (/^#{1,3}\s+\S/.test(line)) return true;
  const t = line.replace(/^#{1,3}\s*/, "");
  return CHAPTER_PATTERNS.some((re) => re.test(t));
}

export function splitIntoSections(text: string): Section[] {
  const sections: Section[] = [];
  let chapter = "";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) sections.push({ chapter, text: body });
    buf = [];
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line && isChapterLine(line)) {
      flush();
      chapter = line.replace(/^#{1,3}\s*/, "").trim();
    } else {
      buf.push(rawLine);
    }
  }
  flush();
  if (!sections.length) {
    const body = text.trim();
    if (body) sections.push({ chapter: "", text: body });
  }
  return sections;
}

function splitSentences(paragraph: string): string[] {
  const parts = paragraph
    .split(/(?<=[。！？!?；;…])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 超长"句子"（无标点的列表等）再按长度硬切
  const out: string[] = [];
  for (const p of parts) {
    if (p.length <= 320) out.push(p);
    else for (let i = 0; i < p.length; i += 320) out.push(p.slice(i, i + 320));
  }
  return out;
}

export function chunkSections(
  sections: Section[],
  opts: { target?: number; max?: number; overlap?: number } = {}
): ChunkDraft[] {
  const target = opts.target ?? 480;
  const max = opts.max ?? 680;
  const overlap = opts.overlap ?? 80;
  const chunks: ChunkDraft[] = [];
  let seq = 0;

  for (const section of sections) {
    const paragraphs = section.text.split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, "\n").trim()).filter(Boolean);
    let cur = "";
    const emit = () => {
      const content = cur.trim();
      if (content) chunks.push({ chapter: section.chapter, seq: seq++, content });
      cur = "";
    };
    for (const para of paragraphs) {
      for (const sentence of splitSentences(para)) {
        if (cur && cur.length + sentence.length > max) {
          const tail = cur.slice(-overlap);
          // 重叠部分从句子边界开始，避免半句
          const cut = tail.search(/[。！？!?；;…\n]/);
          const carry = cut >= 0 && cut < tail.length - 1 ? tail.slice(cut + 1).trim() : "";
          emit();
          cur = carry ? carry + "\n" : "";
        }
        cur += sentence;
        if (cur.length >= target && /[。！？!?；;…]$/.test(sentence)) emit();
      }
      if (cur && !cur.endsWith("\n")) cur += "\n";
    }
    // 过短的尾巴并入上一个 chunk
    const tailContent = cur.trim();
    if (tailContent) {
      const prev = chunks.length ? chunks[chunks.length - 1] : null;
      if (prev && prev.chapter === section.chapter && tailContent.length < 150 && prev.content.length + tailContent.length <= max + 150) {
        prev.content += "\n" + tailContent;
      } else {
        chunks.push({ chapter: section.chapter, seq: seq++, content: tailContent });
      }
      cur = "";
    }
  }
  return chunks.filter((c) => c.content.length >= 20);
}

export function chunkText(text: string): ChunkDraft[] {
  return chunkSections(splitIntoSections(text));
}
