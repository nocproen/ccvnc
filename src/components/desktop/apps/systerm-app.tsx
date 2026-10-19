"use client";

import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDialogs } from "../dialogs";
import { writeTextToLocal } from "../desktop-clip";
import { useSys } from "../sys-store";
import { useWm, type Win } from "../wm-store";
import { withDesktopAccess } from "../client-session";

type Status = "connecting" | "open" | "reconnecting" | "exited" | "failed";

const KEYS: { label: string; seq: string }[] = [
  { label: "Esc", seq: "\x1b" },
  { label: "Tab", seq: "\t" },
  { label: "Ctrl+C", seq: "\x03" },
  { label: "Ctrl+D", seq: "\x04" },
  { label: "Ctrl+Z", seq: "\x1a" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
];

// 终端会话 id 由窗口 id 决定：共享桌面里同一个"终端"窗口，
// 在任何一个网页打开连的都是同一个 shell（刷新 / 换网页不会重开一个）。
const sessionIdOf = (winId: string) => `webdesk-${winId}`;

export function SysTermApp({ win }: { win: Win }) {
  const { info } = useSys();
  const wm = useWm();
  const dlg = useDialogs();
  const wmRef = useRef(wm);
  wmRef.current = wm;
  const dlgRef = useRef(dlg);
  dlgRef.current = dlg;

  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const sendRef = useRef<(m: object) => void>(() => {});
  const startCwd = useRef(win.path ?? info?.home ?? "~");
  const startCmd = useRef(win.cmd ?? "");
  const [status, setStatus] = useState<Status>("connecting");
  const [message, setMessage] = useState("");
  const [runKey, setRunKey] = useState(0);
  const winId = win.id;
  const focused = wm.focusedId === win.id;

  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  useEffect(() => {
    let disposed = false;
    let exited = false;
    let ws: WebSocket | null = null;
    let retry = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let ro: ResizeObserver | null = null;
    let term: import("@xterm/xterm").Terminal | null = null;
    // 服务器推下来的真实行列数导致的 resize 不要再回传给服务器，否则两边会来回改
    let applyingSize = false;
    const sid = sessionIdOf(winId);

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      const host = hostRef.current;
      if (disposed || !host) return;

      const t = new Terminal({
        fontFamily:
          'ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", "Noto Sans Mono CJK SC", "PingFang SC", "Microsoft YaHei", monospace',
        fontSize: 14,
        lineHeight: 1.15,
        cursorBlink: true,
        scrollback: 8000,
        allowProposedApi: true,
        macOptionIsMeta: true,
        theme: {
          background: "#0b1120",
          foreground: "#e2e8f0",
          cursor: "#38bdf8",
          selectionBackground: "#38bdf855",
          black: "#1e293b",
          red: "#f87171",
          green: "#4ade80",
          yellow: "#facc15",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#22d3ee",
          white: "#e2e8f0",
          brightBlack: "#64748b",
          brightRed: "#fca5a5",
          brightGreen: "#86efac",
          brightYellow: "#fde047",
          brightBlue: "#93c5fd",
          brightMagenta: "#d8b4fe",
          brightCyan: "#67e8f9",
          brightWhite: "#f8fafc",
        },
      });
      term = t;
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.loadAddon(
        new WebLinksAddon((e, uri) => {
          e.preventDefault();
          wmRef.current.open("browser", { path: uri });
        }),
      );
      t.open(host);
      try {
        fit.fit();
      } catch {
        /* 容器尚未布局 */
      }
      termRef.current = t;
      t.focus();

      const send = (m: object) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
      };
      sendRef.current = send;

      // 键盘输入 -> 服务器（粘贴大段文本分块发送）
      t.onData((d) => {
        if (exited) {
          if (d.includes("\r")) setRunKey((k) => k + 1);
          return;
        }
        for (let i = 0; i < d.length; i += 16384) send({ t: "i", d: d.slice(i, i + 16384) });
      });
      t.onResize(({ cols, rows }) => {
        if (!applyingSize) send({ t: "r", c: cols, r: rows });
      });

      // 终端里的 `open xxx` 命令 -> 打开桌面应用
      t.parser.registerOscHandler(777, (data) => {
        const parts = data.split(";");
        if (parts[0] === "gui") {
          // gui <命令>：在桌面窗口里运行图形程序
          const dec = (b: string) => {
            try {
              return new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
            } catch {
              return "";
            }
          };
          const cmd = dec(parts[1] ?? "").trim();
          const cwd = dec(parts[2] ?? "").trim();
          if (cmd) wmRef.current.open("gui", { cmd, path: cwd || undefined, name: cmd.split(/\s+/)[0].split("/").pop() });
          return true;
        }
        if (parts[0] !== "open") return false;
        const kind = parts[1];
        const arg = parts.slice(2).join(";");
        if (kind === "url") wmRef.current.open("browser", { path: arg });
        else if (kind === "dir") wmRef.current.open("sysfiles", { path: arg });
        else if (kind === "file") wmRef.current.open("sysedit", { path: arg });
        return true;
      });

      // 复制 / 粘贴只走本机剪贴板：本地复制 → 粘进模拟桌面；终端里选中复制 → 进本机剪贴板
      t.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;
        const mod = ev.ctrlKey || ev.metaKey;
        const k = ev.key.toLowerCase();
        // Ctrl+C：有选中文本 → 复制到本机剪贴板（不再发给 shell）；没有选中 → 照旧当中断键用
        if (mod && !ev.shiftKey && !ev.altKey && k === "c") {
          const text = t.getSelection();
          if (!text) return true;
          t.clearSelection();
          void writeTextToLocal(text).then((ok) =>
            dlgRef.current.toast(ok ? "已复制到本机剪贴板" : "复制失败：浏览器不允许写剪贴板"),
          );
          return false;
        }
        // Ctrl+V：只粘本机剪贴板里的文字
        if (mod && !ev.shiftKey && !ev.altKey && k === "v") {
          void navigator.clipboard?.readText().then((text) => text && t.paste(text));
          return false;
        }
        return true;
      });

      const connect = () => {
        if (disposed) return;
        setStatus(retry ? "reconnecting" : "connecting");
        const proto = location.protocol === "https:" ? "wss" : "ws";
        const url =
          `${proto}://${location.host}/api/term/ws?sid=${sid}&cols=${t.cols}&rows=${t.rows}` +
          `&cwd=${encodeURIComponent(startCwd.current)}` +
          (startCmd.current ? `&cmd=${encodeURIComponent(startCmd.current)}` : "");
        const w = new WebSocket(withDesktopAccess(url));
        w.binaryType = "arraybuffer";
        ws = w;
        let opened = false;

        w.onopen = () => {
          opened = true;
          startCmd.current = ""; // 启动命令只在第一次连接时执行
          retry = 0;
          setStatus("open");
          t.reset(); // 重连时服务器会回放最近输出，先清屏避免重复
          send({ t: "r", c: t.cols, r: t.rows });
        };
        w.onmessage = (ev) => {
          if (typeof ev.data !== "string") {
            t.write(new Uint8Array(ev.data as ArrayBuffer));
            return;
          }
          try {
            const m = JSON.parse(ev.data) as {
              t: string;
              code?: number;
              message?: string;
              c?: number;
              r?: number;
            };
            if (m.t === "exit") {
              exited = true;
              if (!m.code) {
                wmRef.current.close(winId); // 正常 exit：像本地终端一样关闭窗口
              } else {
                setStatus("exited");
                t.write(`\r\n\x1b[90m[进程已退出，代码 ${m.code}。按回车重新启动]\x1b[0m`);
              }
            } else if (m.t === "size" && typeof m.c === "number" && typeof m.r === "number") {
              // 共享终端以持有它的网页为准：这里按真实行列数重新排版
              applyingSize = true;
              try {
                t.resize(m.c, m.r);
              } finally {
                applyingSize = false;
              }
            } else if (m.t === "error") {
              exited = true;
              setStatus("failed");
              setMessage(m.message ?? "无法启动终端");
            }
          } catch {
            /* ignore */
          }
        };
        w.onclose = () => {
          if (disposed || exited) return;
          if (ws === w) ws = null;
          void fetch("/api/sys/info?lite=1").catch(() => {}); // 若登录已失效，返回 401 会让页面回到锁屏
          retry++;
          if (retry > 10 || (!opened && retry > 4)) {
            setStatus("failed");
            setMessage("无法连接到服务器终端");
            return;
          }
          setStatus("reconnecting");
          retryTimer = setTimeout(connect, Math.min(4000, 400 * retry));
        };
        w.onerror = () => {};
      };
      connect();

      // 窗口大小变化 -> 重新适配行列数
      let raf = 0;
      ro = new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          if (host.clientWidth < 40 || host.clientHeight < 30) return;
          try {
            fit.fit();
          } catch {
            /* ignore */
          }
        });
      });
      ro.observe(host);
    })();

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      ro?.disconnect();
      // 不再发 kill：终端是共享的，关掉一个网页 / 刷新不该把别人的 shell 杀掉。
      // 无人连接后服务器会在 2 分钟内自动回收会话。
      ws?.close();
      term?.dispose();
      termRef.current = null;
      sendRef.current = () => {};
    };
  }, [runKey, winId]);

  const press = useCallback((seq: string) => {
    sendRef.current({ t: "i", d: seq });
    termRef.current?.focus();
  }, []);

  return (
    <div className="flex h-full flex-col bg-[#0b1120]">
      <div className="relative min-h-0 flex-1 p-2" onClick={() => termRef.current?.focus()}>
        <div ref={hostRef} className="h-full w-full overflow-hidden" />
        {(status === "connecting" || status === "reconnecting") && (
          <div className="pointer-events-none absolute right-3 top-2 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs text-slate-300">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-sky-400" />
            {status === "connecting" ? "正在连接…" : "连接中断，重连中…"}
          </div>
        )}
        {status === "failed" && (
          <div className="absolute inset-0 grid place-items-center bg-[#0b1120]/95 px-6 text-center text-slate-300">
            <div>
              <div className="mb-2 text-4xl">⚠️</div>
              <div className="text-sm">{message || "终端连接失败"}</div>
              <button
                onClick={() => {
                  setStatus("connecting");
                  setRunKey((k) => k + 1);
                }}
                className="mt-4 rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-medium text-white"
              >
                重新连接
              </button>
            </div>
          </div>
        )}
      </div>
      {wm.isMobile && (
        <div className="flex gap-1 overflow-x-auto border-t border-white/10 bg-black/40 px-2 py-1.5">
          {KEYS.map((k) => (
            <button
              key={k.label}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => press(k.seq)}
              className="shrink-0 rounded-md bg-white/10 px-3 py-1.5 text-xs text-slate-200 active:bg-white/20"
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
