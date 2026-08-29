"use client";

import { useEffect, useState } from "react";

// 演示用身份：无真实登录，cookie 里存一个 user/admin 开关

export type Role = "user" | "admin";

export function readRole(): Role {
  if (typeof document === "undefined") return "user";
  return document.cookie.includes("hr_role=admin") ? "admin" : "user";
}

export function writeRole(role: Role) {
  document.cookie = `hr_role=${role}; path=/; max-age=31536000`;
  window.dispatchEvent(new CustomEvent("hr-role-change"));
}

export function useRole(): [Role, (r: Role) => void] {
  const [role, setRole] = useState<Role>("user");
  useEffect(() => {
    setRole(readRole());
    const onChange = () => setRole(readRole());
    window.addEventListener("hr-role-change", onChange);
    return () => window.removeEventListener("hr-role-change", onChange);
  }, []);
  return [role, (r: Role) => writeRole(r)];
}

export function timeAgo(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const d = new Date(t);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 解析 /api/chat 的 SSE 流 */
export async function consumeSSE(
  res: Response,
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  if (!res.body) throw new Error("连接中断");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const evt of events) {
      const line = evt.trim();
      if (!line.startsWith("data:")) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch {
        // 忽略解析失败的事件
      }
    }
  }
}

export interface SourceItem {
  index: number;
  chunkId: number;
  docTitle: string;
  chapter: string;
  content: string;
}
