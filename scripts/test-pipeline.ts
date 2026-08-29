// 管线自测：解析(docx/epub/gbk txt) → 章节分块 → 分词。直接 node 运行，不依赖 dev server。
import fs from "node:fs";
import path from "node:path";
import { parseUpload, decodeSmart } from "../src/lib/parsers.ts";
import { chunkText, splitIntoSections } from "../src/lib/chunking.ts";
import { segmentForIndex, buildFtsQuery } from "../src/lib/segment.ts";

const fixtures = path.join(import.meta.dirname, "fixtures");
let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failed++;
}

// 1) docx
const docx = parseUpload("test.docx", fs.readFileSync(path.join(fixtures, "test.docx")));
check("docx 标题识别", docx.text.includes("## 第一章 运动是最好的长寿药"));
check("docx 实体解码", docx.text.includes("肌肉量&骨密度"));
check("docx 换行处理", docx.text.includes("胰岛素抵抗是许多慢性病的共同土壤。\n持续血糖监测"));

// 2) GBK txt
const gbk = decodeSmart(fs.readFileSync(path.join(fixtures, "test_gbk.txt")));
check("GBK 解码", gbk.includes("睡眠不足会显著影响代谢与认知功能"));

// 3) epub
const epub = parseUpload("test.epub", fs.readFileSync(path.join(fixtures, "test.epub")));
check("epub 标题", epub.title === "测试之书", epub.title);
check("epub 章节", epub.text.includes("## 第一章 稳定性训练") && epub.text.includes("## 第二章 情绪健康"));
check("epub 正文顺序", epub.text.indexOf("稳定性是力量的前提") < epub.text.indexOf("心理健康与身体健康"));

// 4) 章节切分 + 分块
const sections = splitIntoSections(docx.text);
check("docx 分出 2 个章节", sections.length === 2, `实际 ${sections.length}`);
check("章节名正确", sections[0].chapter === "第一章 运动是最好的长寿药");

const longText = ["# 第一章 测试长章节", ...Array.from({ length: 40 }, (_, i) => `这是第${i}句测试内容，用来验证分块的长度控制是否符合预期，句子里包含足够的字数来填充。`)].join("\n\n");
const chunks = chunkText(longText);
check("长文本切成多块", chunks.length >= 3, `实际 ${chunks.length} 块`);
check("块长度受控", chunks.every((c) => c.content.length <= 700), `最长 ${Math.max(...chunks.map((c) => c.content.length))}`);
check("块继承章节名", chunks.every((c) => c.chapter === "第一章 测试长章节"));

// 5) 分词
const seg = segmentForIndex("Zone 2 训练能提升线粒体功能，降低 ApoB 水平");
check("中文分词", seg.includes("训练") && seg.includes("线粒体"), seg);
check("英文术语保留", seg.includes("zone") && seg.includes("apob"), seg);
const q = buildFtsQuery("书中怎么说 Zone 2 训练？");
check("FTS 查询构造", q.includes('"zone"') && q.includes('"训练"') && !q.includes('"怎么"'), q);

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
