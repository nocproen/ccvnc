"use client";

import { withDesktopAccess } from "./client-session";

// 桌面实时同步：一条 EventSource 连接，所有需要"跨网页同步"的组件共用。
// 断线自动重连（指数退避），重连成功后服务器会先推一份当前快照，错过的改动不会丢。

export type LiveMessage =
  | { type: "workspace"; version: number; snapshot: unknown; hello?: boolean }
  | { type: "settings"; key: string; value: string }
  | { type: "fs" };

type Listener = (msg: LiveMessage) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let retryTimer: number | undefined;
let retries = 0;

function deliver(msg: LiveMessage) {
  for (const fn of [...listeners]) {
    try {
      fn(msg);
    } catch {
      // 某个订阅者报错不影响其他订阅者
    }
  }
}

function open() {
  if (source || typeof window === "undefined") return;
  // EventSource 不能自定义请求头，桌面会话标识只能走 ?access=
  const es = new EventSource(withDesktopAccess("/api/workspace/stream"));
  source = es;
  es.onopen = () => {
    retries = 0;
  };
  es.onmessage = (e: MessageEvent<string>) => {
    let msg: LiveMessage;
    try {
      msg = JSON.parse(e.data) as LiveMessage;
    } catch {
      return;
    }
    if (msg && typeof msg.type === "string") deliver(msg);
  };
  es.onerror = () => {
    // 主动关掉再自己重连：EventSource 的默认重连没有退避，掉线时会疯狂重试
    es.close();
    if (source === es) source = null;
    if (!listeners.size) return;
    const delay = Math.min(5000, 400 * 2 ** Math.min(retries++, 4));
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(open, delay);
  };
}

function close() {
  window.clearTimeout(retryTimer);
  source?.close();
  source = null;
  retries = 0;
}

export function subscribeLive(fn: Listener) {
  listeners.add(fn);
  open();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) close();
  };
}
