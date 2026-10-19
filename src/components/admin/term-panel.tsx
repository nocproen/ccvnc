"use client";

// 后台「终端」：网页终端（xterm.js + PTY），带「开始 / 关闭」按钮。
// 与桌面终端共用 PTY 会话管理，鉴权走管理员 Cookie（/api/admin-term/ws）。
import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

const card = "rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-xl";

export default function TermPanel() {
  const boxRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<{ dispose(): void; focus(): void; cols: number; rows: number; onData(cb: (d: string) => void): void; onResize(cb: (s: { cols: number; rows: number }) => void): void; write(d: string | Uint8Array): void } | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const stop = useRef(() => {});
  stop.current = () => {
    try {
      wsRef.current?.send(JSON.stringify({ t: "kill" }));
    } catch {
      /* ignore */
    }
    try {
      wsRef.current?.close();
    } catch {
      /* ignore */
    }
    wsRef.current = null;
    try {
      termRef.current?.dispose();
    } catch {
      /* ignore */
    }
    termRef.current = null;
    if (boxRef.current) boxRef.current.innerHTML = "";
    setRunning(false);
  };

  useEffect(() => () => stop.current(), []);

  const start = async () => {
    if (running || busy || !boxRef.current) return;
    setBusy(true);
    setMsg("");
    boxRef.current.innerHTML = "";
    try {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      const term = new Terminal({
        fontSize: 13,
        cursorBlink: true,
        fontFamily: 'ui-monospace, Menlo, Consolas, "Courier New", monospace',
        theme: { background: "#0b1120", foreground: "#e2e8f0", cursor: "#38bdf8", selectionBackground: "#1e293b" },
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(boxRef.current);
      fit.fit();
      termRef.current = term as unknown as typeof termRef.current;

      const sid = `adm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/admin-term/ws?sid=${sid}&cols=${term.cols}&rows=${term.rows}`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setRunning(true);
        setBusy(false);
        term.focus();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const m = JSON.parse(ev.data) as { t?: string; c?: number; r?: number; message?: string };
            if (m.t === "exit") {
              setMsg("终端进程已退出");
              stop.current();
            } else if (m.t === "size" && m.c && m.r) {
              term.resize(m.c, m.r);
            } else if (m.t === "error") {
              setMsg(m.message ?? "无法启动终端");
              stop.current();
            }
          } catch {
            /* ignore */
          }
        } else {
          term.write(new Uint8Array(ev.data as ArrayBuffer));
        }
      };
      ws.onclose = () => {
        setRunning(false);
        setBusy(false);
      };
      ws.onerror = () => {
        setMsg("终端连接错误，请重试");
        setRunning(false);
        setBusy(false);
      };
      term.onData((d) => {
        const w = wsRef.current;
        if (w && w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ t: "i", d }));
      });
      term.onResize(({ cols, rows }) => {
        const w = wsRef.current;
        if (w && w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ t: "r", c: cols, r: rows }));
      });
      const onResize = () => {
        try {
          fit.fit();
          const w = wsRef.current;
          if (w && w.readyState === WebSocket.OPEN) w.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("resize", onResize);
      ws.addEventListener("close", () => window.removeEventListener("resize", onResize));
    } catch {
      setMsg("终端组件加载失败");
      setBusy(false);
    }
  };

  return (
    <div className={card}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-medium">服务器终端</span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
            running ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-700/50 text-slate-400"
          }`}
        >
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${running ? "bg-emerald-400" : "bg-slate-500"}`} />
          {running ? "运行中" : "未启动"}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => void start()}
            disabled={running || busy}
            className="rounded-lg bg-sky-500 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-40"
          >
            开始
          </button>
          <button
            type="button"
            onClick={() => stop.current()}
            disabled={!running}
            className="rounded-lg bg-red-500/20 px-4 py-1.5 text-xs font-medium text-red-200 hover:bg-red-500/40 disabled:opacity-40"
          >
            关闭
          </button>
        </div>
      </div>

      <div ref={boxRef} className="h-[26rem] overflow-hidden rounded-lg border border-white/10 bg-[#0b1120]" />

      {!running && !busy && (
        <div className="mt-3 text-xs text-slate-500">
          点「开始」启动一个交互式终端（支持方向键、Tab 补全、Ctrl+C、vim/top 等全交互）。{msg && <span className="ml-2 text-amber-300">{msg}</span>}
        </div>
      )}
      {busy && <div className="mt-3 text-xs text-slate-400">正在启动…</div>}
      {running && msg && <div className="mt-3 text-xs text-amber-300">{msg}</div>}
    </div>
  );
}
