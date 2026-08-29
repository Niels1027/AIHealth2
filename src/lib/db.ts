import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

function createDb(): DatabaseSync {
  const dataDir = path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "healthrag.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'paste',
      status TEXT NOT NULL DEFAULT 'processing',
      progress REAL NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      char_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL,
      chapter TEXT NOT NULL DEFAULT '',
      seq INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(seg);
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '新对话',
      summary TEXT NOT NULL DEFAULT '',
      summarized_upto INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      sources TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

// 开发模式热更新时复用同一个连接
const g = globalThis as unknown as { __healthragDb?: DatabaseSync };
export const db: DatabaseSync = (g.__healthragDb ??= createDb());

export const now = () => new Date().toISOString();

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? String(row.value) : null;
}

export function setMeta(key: string, value: string) {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export interface DocumentRow {
  id: number;
  title: string;
  source: string;
  status: "processing" | "ready" | "error";
  progress: number;
  chunk_count: number;
  char_count: number;
  error: string | null;
  created_at: string;
}

export function listDocuments(): DocumentRow[] {
  return db
    .prepare("SELECT * FROM documents ORDER BY id DESC")
    .all() as unknown as DocumentRow[];
}

export function getDocument(id: number): DocumentRow | undefined {
  return db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as unknown as
    | DocumentRow
    | undefined;
}

export function deleteDocument(id: number) {
  db.prepare(
    "DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE doc_id = ?)"
  ).run(id);
  db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(id);
  db.prepare("DELETE FROM documents WHERE id = ?").run(id);
}

export function kbStats() {
  const docs = db.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number };
  const ready = db
    .prepare("SELECT COUNT(*) c FROM documents WHERE status = 'ready'")
    .get() as { c: number };
  const chunks = db.prepare("SELECT COUNT(*) c FROM chunks").get() as { c: number };
  const embedded = db
    .prepare("SELECT COUNT(*) c FROM chunks WHERE embedding IS NOT NULL")
    .get() as { c: number };
  const convs = db.prepare("SELECT COUNT(*) c FROM conversations").get() as { c: number };
  return {
    documents: Number(docs.c),
    readyDocuments: Number(ready.c),
    chunks: Number(chunks.c),
    embeddedChunks: Number(embedded.c),
    conversations: Number(convs.c),
  };
}
