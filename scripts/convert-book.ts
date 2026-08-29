// 把《超越百岁》PDF（中译出版社官方译本）转成分章 Markdown，供 ingest 管线使用。
//
// PDF 版面特点（已实测）：无页眉页脚，正文按 30 字符硬换行，章标题独立成行、
// 副标题在其后一个非空行。因此段落边界的判据是"行长 < 30 即段落结束"。
//
// 用法: pnpm dlx tsx scripts/convert-book.ts <input.pdf> [output.md]
//   或: node --experimental-strip-types scripts/convert-book.ts <input.pdf>
// 依赖: pdftotext (poppler) —— brew install poppler

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 满行宽度：PDF 正文按 30 字符换行 */
const WRAP_WIDTH = 29;

const CN_NUM = "[〇一二三四五六七八九十百]+";
const RE_CHAPTER = new RegExp(`^第\\s*(?:${CN_NUM}|\\d+)\\s*章$`);
const RE_PART = new RegExp(`^第\\s*(?:${CN_NUM}|\\d+)\\s*部分$`);
/** 正文起点：导言/前言。终点：致谢/参考文献（其后是参考文献与索引，对问答是噪声） */
const RE_BODY_START = /^(导言|前言|引言|序言)$/;
const RE_BODY_END = /^(致谢|参考文献|参考资料|注释|索引)$/;
/** 脚注终止符。原书排版把译者/作者注直接插在段落之间，此标记必定收尾 */
const RE_NOTE_END = /——\s*(译者注|作者注|编者注)$/;
const RE_SENTENCE_END = /[。！？…\!\?][”’」』）\)】]?$/;

/**
 * 段落是否在 line 之后结束。
 *
 * 不能只看行长：正文两端对齐，下一行若以长英文词组开头（如"（Johns Hopkins
 * Hospital）"），本行会提前换行而并未结束段落。也不能只看空行：\f 分页会
 * 在句子中间插入空行。因此要求先满足句末标点，再看行长或空行。
 */
function endsParagraph(line: string, next: string | undefined): boolean {
  if (RE_NOTE_END.test(line)) return true;
  if (!RE_SENTENCE_END.test(line)) return false;
  return line.length < WRAP_WIDTH || !next?.trim();
}

function pdfToText(pdfPath: string): string {
  try {
    return execFileSync("pdftotext", ["-enc", "UTF-8", pdfPath, "-"], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new Error("未找到 pdftotext，请先安装 poppler：brew install poppler");
    }
    throw err;
  }
}

interface Block {
  kind: "chapter" | "para" | "note";
  text: string;
  label?: string;
}

/** 定位正文区间：[导言, 致谢) —— 剔除版权页/推荐语与参考文献/索引 */
function findBodyRange(lines: string[]): { start: number; end: number } {
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (start < 0 && RE_BODY_START.test(t)) start = i;
    // 取最后一个匹配之前的第一个后置标记，且必须在正文开始之后
    if (start >= 0 && end < 0 && i > start + 100 && RE_BODY_END.test(t)) end = i;
  }
  if (start < 0) {
    // 回退：从第一个"第一部分"或"第一章"开始
    start = lines.findIndex((l) => RE_PART.test(l.trim()) || RE_CHAPTER.test(l.trim()));
  }
  if (start < 0) throw new Error("无法定位正文起点（未找到 导言/前言/第一章）");
  if (end < 0) end = lines.length;
  return { start, end };
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let buf: string[] = [];

  const flushPara = () => {
    const raw = buf.join("").trim();
    buf = [];
    if (!raw) return;

    // 译者/作者注：原书排在段落之间，抽出来单独成块，避免污染正文语义
    const note = raw.match(RE_NOTE_END);
    if (note) {
      blocks.push({ kind: "note", text: raw.replace(RE_NOTE_END, "").trim(), label: note[1] });
      return;
    }

    // 少数脚注被排版嵌在段落中间，起点无法可靠还原；至少在标记处断开，
    // 避免一个句子横跨脚注。保留标记原文，不臆断归属。
    const inline = raw.match(/——\s*(?:译者注|作者注|编者注)/);
    if (inline?.index !== undefined) {
      const cut = inline.index + inline[0].length;
      blocks.push({ kind: "para", text: raw.slice(0, cut).trim() });
      const rest = raw.slice(cut).trim();
      if (rest) blocks.push({ kind: "para", text: rest });
      return;
    }

    blocks.push({ kind: "para", text: raw });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) continue; // 空行本身不构成段落边界，判定交给 endsParagraph

    // 部分分隔（第一部分/第二部分）不产生标题，避免制造空章节
    if (RE_PART.test(t)) {
      flushPara();
      continue;
    }

    // 章标题：独立成行。副标题排在其后的空行之后，用大号字排版，
    // 换行宽度与正文不同，因此按"连续非空行"收集而非按行长判断。
    if (RE_CHAPTER.test(t)) {
      flushPara();
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++; // 跳过标题与副标题之间的空行
      const parts: string[] = [];
      while (j < lines.length && lines[j].trim()) {
        parts.push(lines[j].trim());
        j++;
      }
      const sub = parts.join("");
      // 副标题应短小；过长说明该章无副标题，收到的是正文，不消费
      if (sub && sub.length <= 40 && !RE_CHAPTER.test(sub)) i = j - 1;
      blocks.push({ kind: "chapter", text: sub && sub.length <= 40 ? `${t} ${sub}` : t });
      continue;
    }

    // 导言等前置标题
    if (RE_BODY_START.test(t)) {
      flushPara();
      blocks.push({ kind: "chapter", text: t });
      continue;
    }

    // 纯英文小标题行（PREFACE 等）丢弃
    if (/^[A-Z][A-Z\s]{2,30}$/.test(t)) {
      flushPara();
      continue;
    }

    buf.push(t);
    if (endsParagraph(t, lines[i + 1])) flushPara();
  }
  flushPara();
  return blocks;
}

function render(blocks: Block[], title: string): string {
  const out: string[] = [`# ${title}`, ""];
  for (const b of blocks) {
    if (b.kind === "chapter") out.push(`## ${b.text}`, "");
    else if (b.kind === "note") out.push(`> ${b.label ?? "译者注"}：${b.text}`, "");
    else out.push(b.text, "");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("用法: convert-book.ts <input.pdf> [output.md]");
    process.exit(1);
  }
  const title = "超越百岁：长寿的科学与艺术";
  const output =
    process.argv[3] ?? path.join(import.meta.dirname, "..", "data", "books", `${title}.md`);

  const raw = pdfToText(input);
  const lines = raw.replace(/\f/g, "\n").split("\n");
  const { start, end } = findBodyRange(lines);
  console.log(`正文区间: 行 ${start} – ${end}（原文共 ${lines.length} 行）`);

  const blocks = parseBlocks(lines.slice(start, end));
  const chapters = blocks.filter((b) => b.kind === "chapter");
  const notes = blocks.filter((b) => b.kind === "note");
  const md = render(blocks, title);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, md, "utf-8");

  console.log(`章节数: ${chapters.length}`);
  console.log(`段落数: ${blocks.filter((b) => b.kind === "para").length}`);
  console.log(`译者注: ${notes.length}`);
  console.log(`字符数: ${md.length.toLocaleString()}`);
  console.log(`已写入: ${output}`);
  console.log(`\n章节列表:`);
  for (const c of chapters) console.log(`  · ${c.text}`);
}

main();
