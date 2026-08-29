import { chunkText } from "./chunking.ts";
import { db, getDocument, now, getMeta, setMeta } from "./db.ts";
import { embed, embedSignature } from "./embeddings.ts";
import { invalidateVecCache } from "./retrieval.ts";
import { segmentForIndex } from "./segment.ts";

// 入库管线：文本 → 章节分块 → 写库（含 FTS）→ 后台批量向量化（带进度）。

const BATCH_SIZE = 16;
const active = new Set<number>();

export function createDocumentWithChunks(title: string, source: string, text: string): number {
  const clean = text.trim();
  if (clean.length < 50) throw new Error("内容太短（不足 50 字），请检查文件或粘贴的文本");
  if (clean.length > 5_000_000) throw new Error("内容超过 500 万字符，请拆分后上传");
  const chunks = chunkText(clean);
  if (!chunks.length) throw new Error("没有解析出有效内容");

  db.exec("BEGIN");
  try {
    const res = db
      .prepare(
        "INSERT INTO documents(title, source, status, progress, chunk_count, char_count, created_at) VALUES(?, ?, 'processing', 0, ?, ?, ?)"
      )
      .run(title.trim() || "未命名文档", source, chunks.length, clean.length, now());
    const docId = Number(res.lastInsertRowid);
    const insChunk = db.prepare(
      "INSERT INTO chunks(doc_id, chapter, seq, content) VALUES(?, ?, ?, ?)"
    );
    const insFts = db.prepare("INSERT INTO chunks_fts(rowid, seg) VALUES(?, ?)");
    for (const c of chunks) {
      const r = insChunk.run(docId, c.chapter, c.seq, c.content);
      insFts.run(Number(r.lastInsertRowid), segmentForIndex(`${c.chapter} ${c.content}`));
    }
    db.exec("COMMIT");
    return docId;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

async function ensureSignature(): Promise<void> {
  const [probe] = await embed(["索引维度探测"]);
  const sig = embedSignature(probe.length);
  const existing = getMeta("embed_signature");
  if (!existing) {
    setMeta("embed_signature", sig);
  } else if (existing !== sig) {
    throw new Error(
      `当前 embedding 配置（${sig}）与已建索引（${existing}）不一致。请在管理页点击"重建全部索引"，或把 .env.local 恢复为原配置后重启。`
    );
  }
}

export async function runIngest(docId: number): Promise<void> {
  if (active.has(docId)) return;
  active.add(docId);
  try {
    await ensureSignature();
    const total = (
      db.prepare("SELECT COUNT(*) c FROM chunks WHERE doc_id = ?").get(docId) as { c: number }
    ).c;
    let done = Number(
      (
        db
          .prepare("SELECT COUNT(*) c FROM chunks WHERE doc_id = ? AND embedding IS NOT NULL")
          .get(docId) as { c: number }
      ).c
    );

    while (true) {
      const batch = db
        .prepare(
          "SELECT id, chapter, content FROM chunks WHERE doc_id = ? AND embedding IS NULL ORDER BY id LIMIT ?"
        )
        .all(docId, BATCH_SIZE) as unknown as { id: number; chapter: string; content: string }[];
      if (!batch.length) break;
      const inputs = batch.map((b) => (b.chapter ? `${b.chapter}\n${b.content}` : b.content));
      const vectors = await embed(inputs);
      const upd = db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
      for (let i = 0; i < batch.length; i++) {
        const v = vectors[i];
        upd.run(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), Number(batch[i].id));
      }
      done += batch.length;
      db.prepare("UPDATE documents SET progress = ? WHERE id = ?").run(
        total ? done / total : 1,
        docId
      );
    }

    db.prepare("UPDATE documents SET status = 'ready', progress = 1, error = NULL WHERE id = ?").run(docId);
    invalidateVecCache();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.prepare("UPDATE documents SET status = 'error', error = ? WHERE id = ?").run(
      msg.slice(0, 500),
      docId
    );
  } finally {
    active.delete(docId);
  }
}

/** 异步启动，不阻塞请求返回 */
export function startIngest(docId: number) {
  void runIngest(docId);
}

export function reprocessDocument(docId: number, force = false) {
  const doc = getDocument(docId);
  if (!doc) throw new Error("文档不存在");
  if (force) {
    db.prepare("UPDATE chunks SET embedding = NULL WHERE doc_id = ?").run(docId);
    invalidateVecCache();
  }
  db.prepare("UPDATE documents SET status = 'processing', error = NULL WHERE id = ?").run(docId);
  startIngest(docId);
}

/** 换 embedding 模型后重建全部索引 */
export async function reindexAll(): Promise<void> {
  const [probe] = await embed(["索引维度探测"]);
  setMeta("embed_signature", embedSignature(probe.length));
  db.exec("UPDATE chunks SET embedding = NULL");
  db.exec("UPDATE documents SET status = 'processing', progress = 0, error = NULL");
  invalidateVecCache();
  const docs = db.prepare("SELECT id FROM documents").all() as unknown as { id: number }[];
  for (const d of docs) startIngest(Number(d.id));
}
