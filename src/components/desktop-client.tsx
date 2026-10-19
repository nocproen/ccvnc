"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LoginScreen } from "@/components/login-screen";
import { installDesktopSession } from "@/components/desktop/client-session";
import ExternalFullscreen from "@/components/external-fullscreen";

type LockState = "ready" | "unset" | "expired";

export default function DesktopClient({ lock, maxSessions = 0 }: { lock: LockState; maxSessions?: number }) {
  const [session, setSession] = useState<string | null>(null);
  const [wasKicked, setWasKicked] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);

  const leave = useCallback(() => {
    cleanup.current?.();
    cleanup.current = null;
    setSession(null);
    setWasKicked(true);
  }, []);

  const enter = useCallback((id: string) => {
    cleanup.current?.();
    cleanup.current = installDesktopSession(id, leave);
    setWasKicked(false);
    setSession(id);
  }, [leave]);

  useEffect(() => () => {
    cleanup.current?.();
    cleanup.current = null;
  }, []);

  useEffect(() => {
    if (!session) return;
    // 关掉/刷新这个网页时立刻注销自己的会话，把席位还回去。
    // 不这么做的话每刷新一次就多一个"幽灵会话"赖在在线列表里，攒满上限后
    // 下一个登录就会按「先登录先下线」把真正在用的那个标签页挤掉 ——
    // 表现就是明明没有 3 个人在线却被踢下线。
    const bye = (e: PageTransitionEvent) => {
      // 进后退/前进缓存（persisted）不算离开，稍后可能被原样恢复
      if (e.persisted) return;
      void fetch("/api/auth/logout", { method: "POST", keepalive: true, cache: "no-store" }).catch(() => {});
    };
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let busy = false;
    let consecutiveErrors = 0;
    const check = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch("/api/auth/session", { cache: "no-store" });
        if (response.status === 401) {
          // 被踢：其他设备登录或密码过期
          leave();
          return;
        }
        if (response.ok) {
          consecutiveErrors = 0;
          return;
        }
        // 503 等临时错误不踢人，只记录
        if (response.status >= 500) {
          consecutiveErrors++;
          return;
        }
        // 其他 4xx 也视为踢人
        if (response.status === 401) leave();
      } catch {
        // 网络短暂离线不能误判为被踢；恢复网络后继续检查。
        consecutiveErrors++;
      } finally {
        busy = false;
      }
    };
    const onResume = () => { if (!document.hidden) void check(); };
    // 延长心跳到 8 秒，降低服务器压力，避免频繁误判
    const timer = window.setInterval(() => void check(), 8000);
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [session, leave]);

  if (!session) {
    return (
      <LoginScreen
        lock={lock}
        maxSessions={maxSessions}
        onAuthenticated={enter}
        message={
          wasKicked
            ? maxSessions > 0
              ? `在线人数已满（最多 ${maxSessions} 人同时在线），当前页面被新的登录挤下线，或访问密码已变更。请重新输入密码。`
              : "当前页面的登录已失效（可能被管理员强制下线，或访问密码已变更）。请重新输入密码。"
            : undefined
        }
      />
    );
  }
  return <ExternalFullscreen onExit={leave} />;
}
