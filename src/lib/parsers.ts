import { readZipEntries } from "./zip.ts";

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** 智能解码：优先 UTF-8，失败则尝试 GB18030（覆盖 GBK/GB2312 的中文 txt） */
export function decodeSmart(buf: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    try {
      text = new TextDecoder("gb18030").decode(buf);
    } catch {
      text = buf.toString("utf8");
    }
  }
  return text.replace(/^﻿/, "");
}

/** .docx 提取：解析 word/document.xml，标题样式转为 "## " 行 */
export function docxToText(buf: Buffer): string {
  const entries = readZipEntries(buf);
  const doc = entries.get("word/document.xml");
  if (!doc) throw new Error("无法解析 .docx 文件（缺少 word/document.xml）");
  const xml = doc.toString("utf8");
  const lines: string[] = [];
  for (const p of xml.split(/<\/w:p>/)) {
    const isHeading = /<w:pStyle[^>]*w:val="(?:[Hh]eading[ ]?[1-6]|Title|[1-3]|标题[ ]?[1-6])"/.test(p);
    let text = "";
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/?>|<w:tab\s*\/?>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p))) {
      if (m[0].startsWith("<w:t")) text += decodeXmlEntities(m[1]);
      else if (m[0].startsWith("<w:br")) text += "\n";
      else text += " ";
    }
    text = text.trim();
    if (text) lines.push(isHeading ? `## ${text}` : text);
  }
  return lines.join("\n\n");
}

function htmlToText(html: string): string {
  let s = html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, _l, inner) => {
    const t = inner.replace(/<[^>]+>/g, "").trim();
    return t ? `\n\n## ${t}\n\n` : "\n\n";
  });
  s = s
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  s = decodeXmlEntities(s);
  return s
    .split(/\n/)
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeZipPath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

/** .epub 提取：按 OPF spine 顺序拼接各 xhtml 章节 */
export function epubToText(buf: Buffer): { title?: string; text: string } {
  const entries = readZipEntries(buf);
  const container = entries.get("META-INF/container.xml")?.toString("utf8") ?? "";
  const opfPath = /full-path="([^"]+)"/.exec(container)?.[1];
  if (!opfPath || !entries.has(opfPath)) throw new Error("无法解析 .epub 文件（找不到 OPF）");
  const opf = entries.get(opfPath)!.toString("utf8");
  const title = /<dc:title[^>]*>([^<]+)<\/dc:title>/.exec(opf)?.[1]?.trim();

  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\s+[^>]*\/?>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (id && href) manifest.set(id, decodeURIComponent(href));
  }
  const baseDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const parts: string[] = [];
  for (const m of opf.matchAll(/<itemref\s+[^>]*idref="([^"]+)"/g)) {
    const href = manifest.get(m[1]);
    if (!href) continue;
    const entry = entries.get(normalizeZipPath(baseDir + href));
    if (!entry) continue;
    const text = htmlToText(entry.toString("utf8"));
    if (text) parts.push(text);
  }
  if (!parts.length) throw new Error("epub 中没有解析到正文内容");
  return { title, text: parts.join("\n\n") };
}

export interface ParsedUpload {
  title: string;
  text: string;
}

/** 根据文件名后缀选择解析器 */
export function parseUpload(filename: string, buf: Buffer): ParsedUpload {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  const baseName = filename.replace(/\.[^.]+$/, "").trim() || "未命名文档";
  if (ext === ".docx") return { title: baseName, text: docxToText(buf) };
  if (ext === ".epub") {
    const { title, text } = epubToText(buf);
    return { title: title || baseName, text };
  }
  if (ext === ".txt" || ext === ".md" || ext === ".markdown") {
    return { title: baseName, text: decodeSmart(buf) };
  }
  throw new Error(`暂不支持 ${ext || "该"} 格式，请使用 .txt / .md / .docx / .epub，或直接粘贴文本`);
}
