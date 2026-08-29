import { db } from "./db.ts";
import { embed } from "./embeddings.ts";
import { buildFtsQuery } from "./segment.ts";

// 混合检索：向量（余弦）+ FTS5 关键词（BM25），RRF 融合。
// 单书规模（几百~几千个 chunk）直接内存暴力算余弦，简单且足够快。

export interface RetrievedChunk {
  chunkId: number;
  docId: number;
  docTitle: string;
  chapter: string;
  content: string;
  score: number;
  cosine?: number;
}

interface VecEntry {
  id: number;
  vec: Float32Array;
}

const g = globalThis as unknown as { __hrVecCache?: VecEntry[] | null };

export function invalidateVecCache() {
  g.__hrVecCache = null;
}

function loadVecCache(): VecEntry[] {
  if (g.__hrVecCache) return g.__hrVecCache;
  const rows = db
    .prepare("SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL")
    .all() as unknown as { id: number; embedding: Uint8Array }[];
  const cache: VecEntry[] = rows.map((r) => {
    const copy = r.embedding.slice();
    return { id: Number(r.id), vec: new Float32Array(copy.buffer, 0, copy.byteLength / 4) };
  });
  g.__hrVecCache = cache;
  return cache;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function hasIndexedChunks(): boolean {
  const row = db
    .prepare("SELECT 1 ok FROM chunks WHERE embedding IS NOT NULL LIMIT 1")
    .get();
  return !!row;
}

export async function retrieve(
  query: string,
  k = 8
): Promise<{ results: RetrievedChunk[]; maxCosine: number }> {
  const CAND = 24;
  const cache = loadVecCache();

  // 1) 向量召回
  let vecRanked: { id: number; cosine: number }[] = [];
  if (cache.length) {
    const [qv] = await embed([query]);
    vecRanked = cache
      .map((e) => ({ id: e.id, cosine: dot(e.vec, qv) }))
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, CAND);
  }

  // 2) 关键词召回（BM25，分数越小越相关）
  let ftsRanked: number[] = [];
  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery) {
    try {
      const rows = db
        .prepare(
          "SELECT rowid AS id, bm25(chunks_fts) AS s FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY s LIMIT ?"
        )
        .all(ftsQuery, CAND) as unknown as { id: number; s: number }[];
      ftsRanked = rows.map((r) => Number(r.id));
    } catch {
      // 查询词触发 FTS 语法问题时静默降级为纯向量
    }
  }

  // 3) RRF 融合
  const K = 60;
  const scores = new Map<number, number>();
  const cosines = new Map<number, number>();
  vecRanked.forEach((r, i) => {
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (K + i + 1));
    cosines.set(r.id, r.cosine);
  });
  ftsRanked.forEach((id, i) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (K + i + 1));
  });

  const topIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([id]) => id);
  if (!topIds.length) return { results: [], maxCosine: 0 };

  const placeholders = topIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT c.id, c.doc_id, c.chapter, c.content, d.title
       FROM chunks c JOIN documents d ON d.id = c.doc_id
       WHERE c.id IN (${placeholders}) AND c.embedding IS NOT NULL`
    )
    .all(...topIds) as unknown as {
    id: number;
    doc_id: number;
    chapter: string;
    content: string;
    title: string;
  }[];

  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const results: RetrievedChunk[] = [];
  for (const id of topIds) {
    const r = byId.get(id);
    if (!r) continue;
    results.push({
      chunkId: id,
      docId: Number(r.doc_id),
      docTitle: r.title,
      chapter: r.chapter,
      content: r.content,
      score: scores.get(id) ?? 0,
      cosine: cosines.get(id),
    });
  }
  const maxCosine = vecRanked.length ? vecRanked[0].cosine : 0;
  return { results, maxCosine };
}
