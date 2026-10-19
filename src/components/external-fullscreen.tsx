"use client";

// 全屏外部 VNC 桌面（替代原 WebDesktop 模拟桌面的登录后界面）：
// 输入桌面密码登录后，直接创建 external 会话，全屏显示 tigervncserver 的 VNC 桌面（如 XFCE4）。
// 复用 gui-app.tsx 的会话启动 + noVNC 连接 + 页面内密码浮层逻辑，去掉窗口管理器 / 任务栏 / 桌面图标等模拟桌面 UI。
import { useCallback, useEffect, useRef, useState } from "react";
import { withDesktopAccess } from "./desktop/client-session";

// 外部 VNC 端口：构建时可用 NEXT_PUBLIC_EXT_VNC_PORT 覆盖，默认 5901（tigervncserver :1）
const EXT_VNC_PORT = Number(process.env.NEXT_PUBLIC_EXT_VNC_PORT ?? 5901);

type Status = {
  state: "preparing" | "starting" | "running" | "exited" | "failed";
  note: string;
  log: string;
  exitCode: number | null;
  name: string;
};

// noVNC 最小接口
type Rfb = {
  disconnect(): void;
  focus(): void;
  addEventListener(type: string, cb: (e: CustomEvent) => void): void;
  sendCredentials?(credentials: { password: string }): void;
  scaleViewport: boolean;
  resizeSession: boolean;
  showDotCursor: boolean;
  qualityLevel: number;
  compressionLevel: number;
  background: string;
  clipboardPasteFrom?(text: string): void;
};
type RfbCtor = new (target: HTMLElement, url: string, opts?: object) => Rfb;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// navigator.clipboard API 只在安全上下文（https / localhost）可用；局域网 http 部署会退回手动粘贴/execCommand
const isSecureCtx =
  typeof location !== "undefined" &&
  (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1");

// 密码只存在本机浏览器 localStorage；认证失败会自动清除并重新弹出输入框（见下方浮层）
const EXT_PASS_KEY = "webdesk.extvnc.password";
function getStoredExtPass(): string {
  try {
    return localStorage.getItem(EXT_PASS_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveExtPass(pw: string) {
  try {
    if (pw) localStorage.setItem(EXT_PASS_KEY, pw);
    else localStorage.removeItem(EXT_PASS_KEY);
  } catch {
    /* ignore */
  }
}

// noVNC 以原生 ES 模块方式从 /novnc 加载（顶层 await，不适合被打包）
async function loadRfb(): Promise<RfbCtor> {
  const url = "/novnc/core/rfb.js";
  const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
  return mod.default as RfbCtor;
}

// 剪贴板工具：http 局域网部署（非安全上下文）时 navigator.clipboard 不可用，
// 读本机剪贴板退回"用户手动粘贴到输入框"（用户手势粘贴天然允许）；
// 写本机剪贴板退回 execCommand('copy')（在按钮点击的手势内可用）。
async function readLocalClipboard(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) {
      const t = await navigator.clipboard.readText();
      if (t) return t;
    }
  } catch {
    /* 无权限或不可用，交给用户手动粘贴 */
  }
  return "";
}
function writeLocalClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(() => resolve(true)).catch(() => resolve(fallbackCopy(text)));
      } else {
        resolve(fallbackCopy(text));
      }
    } catch {
      resolve(false);
    }
  });
}
function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

async function getStatus(sid: string): Promise<Status | "error"> {
  try {
    const r = await fetch(`/api/gui/${sid}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return "error";
    return (await r.json()) as Status;
  } catch {
    return "error";
  }
}

export default function ExternalFullscreen({ onExit }: { onExit: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<Rfb | null>(null);
  const [phase, setPhase] = useState<"preparing" | "running" | "ended">("preparing");
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [runKey, setRunKey] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [extPw, setExtPw] = useState("");
  const [extPwPrompt, setExtPwPrompt] = useState(false);
  // 剪贴板面板（走 VNC 协议层剪贴板：远程复制 → 网页；网页 → 远程）
  const [clipPanel, setClipPanel] = useState(false);
  const [remoteClip, setRemoteClip] = useState("");
  const [sendText, setSendText] = useState("");
  const [clipMsg, setClipMsg] = useState("");

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", keepalive: true, cache: "no-store" }).catch(() => {});
    } catch {
      /* ignore */
    }
    onExit();
  }, [onExit]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    let sid: string | null = null;
    let rfb: Rfb | null = null;
    let serverPw = ""; // 后台保存的 VNC 密码（POST /api/gui 下发）：优先用它，前端无需手动输入
    let everConnected = false;
    let connectedAt = 0;

    const end = (message: string, st?: Status) => {
      if (dead) return;
      if (st) setStatus(st);
      setErr(message);
      setReconnecting(false);
      setPhase("ended");
    };

    const connect = async () => {
      let RFB: RfbCtor;
      try {
        RFB = await loadRfb();
      } catch {
        return end("无法加载远程桌面组件");
      }
      if (dead) return;
      // 优先用后台保存的 VNC 密码（服务器下发，无需输入）；没有才用本机存储，再没有则弹出输入浮层
      const pw = serverPw || getStoredExtPass();
      if (!pw) {
        setExtPwPrompt(true);
        return;
      }
      host.innerHTML = "";
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const r = new RFB(host, withDesktopAccess(`${proto}://${location.host}/api/gui/ws?sid=${sid}`), {
        shared: true,
        credentials: { password: pw },
      });
      rfb = r;
      rfbRef.current = r;
      r.scaleViewport = false;
      r.resizeSession = true; // 网页窗口变化时让远程桌面分辨率跟随（TigerVNC 支持 SetDesktopSize）
      r.showDotCursor = false;
      r.background = "#0b1120";
      r.qualityLevel = 7;
      r.compressionLevel = 2;
      // 服务器要求凭据而当前密码无效：清掉并弹出输入框
      r.addEventListener("credentialsrequired", () => {
        saveExtPass("");
        setExtPwPrompt(true);
      });
      let connected = false;
      const connTimer = setTimeout(() => {
        if (!connected && rfb === r) r.disconnect();
      }, 12_000);
      r.addEventListener("connect", () => {
        connected = true;
        clearTimeout(connTimer);
        everConnected = true;
        connectedAt = Date.now();
        setReconnecting(false);
        setPhase("running");
        r.focus();
      });
      // 远程桌面里复制的文本：通过 VNC 协议层剪贴板事件收到，显示在面板里
      r.addEventListener("clipboard", (e) => {
        const text = (e.detail as { text?: string } | undefined)?.text;
        if (text) {
          setRemoteClip(text);
          setClipMsg("");
        }
      });
      r.addEventListener("disconnect", async () => {
        clearTimeout(connTimer);
        if (dead) return;
        if (rfbRef.current === r) rfbRef.current = null;
        // 从未连上就被服务器断开：几乎一定是 VNC 认证失败（密码错误/为空），清密码重新输入，不再无限转圈
        if (!connected) {
          saveExtPass("");
          setExtPwPrompt(true);
          return;
        }
        setReconnecting(true);
        if (Date.now() - connectedAt > 3000) {
          void connect();
          return;
        }
        // 断线重试：会话还在就重连；失败间隔逐渐拉长
        let wait = 600;
        for (;;) {
          const st = sid ? await getStatus(sid) : "error";
          if (dead) return;
          if (st !== "error" && st.state === "running") {
            void connect();
            return;
          }
          if (st !== "error" && (st.state === "failed" || st.state === "exited")) {
            return end(st.state === "failed" ? st.note || "启动失败" : "应用已退出", st);
          }
          setReconnecting(true);
          await sleep(wait);
          if (dead) return;
          wait = Math.min(wait * 1.6, 15_000);
        }
      });
      r.addEventListener("error", () => {
        /* disconnect 事件会兜底处理 */
      });
    };

    (async () => {
      setPhase("preparing");
      setStatus(null);
      setErr("");
      try {
        const res = await fetch("/api/gui", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ external: { port: EXT_VNC_PORT }, name: "外部桌面", w: 1920, h: 1080 }),
        });
        const d = (await res.json().catch(() => ({}))) as { sid?: string; error?: string; password?: string };
        if (!res.ok || !d.sid) return end(d.error ?? "启动失败");
        sid = d.sid;
        serverPw = d.password ?? ""; // 后台已保存 VNC 密码 → 直连免输入
        for (;;) {
          const st = await getStatus(sid);
          if (dead) return;
          if (st === "error") {
            await sleep(700);
            continue;
          }
          setStatus(st);
          if (st.state === "running") break;
          if (st.state === "exited" || st.state === "failed") {
            return end(st.state === "failed" ? st.note || "启动失败" : "应用已退出", st);
          }
          await sleep(700);
        }
        await connect();
      } catch {
        end("网络错误");
      }
    })();

    return () => {
      dead = true;
      rfb?.disconnect();
      rfbRef.current = null;
      if (sid) void fetch(`/api/gui/${sid}`, { method: "DELETE", keepalive: true }).catch(() => {});
      host.innerHTML = "";
    };
  }, [runKey]);

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0b1120] text-white">
      {/* VNC 画面 */}
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />

        {phase === "preparing" && (
          <div className="absolute inset-0 grid place-items-center bg-[#0b1120] px-6 text-center text-slate-300">
            <div>
              <div className="mx-auto mb-4 h-9 w-9 animate-spin rounded-full border-2 border-white/20 border-t-sky-400" />
              <div className="text-sm">{status?.note || "正在连接外部桌面…"}</div>
              <div className="mt-2 text-xs text-slate-500">如长时间无反应，请确认 tigervncserver 已启动（端口 {EXT_VNC_PORT}）</div>
            </div>
          </div>
        )}

        {reconnecting && phase === "running" && (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
            <div className="rounded-xl bg-black/60 px-6 py-4 text-center text-slate-200 shadow-lg backdrop-blur">
              <div className="mx-auto mb-3 h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-sky-400" />
              <div className="text-sm">连接中断，正在重新连接…</div>
            </div>
          </div>
        )}

        {phase === "ended" && (
          <div className="absolute inset-0 grid place-items-center overflow-y-auto bg-[#0b1120] px-6 py-8 text-slate-300">
            <div className="mx-auto max-w-xl text-center">
              <div className="mb-2 text-4xl">⚠️</div>
              <div className="text-sm">{err || "会话已结束"}</div>
              {status?.log && (
                <pre className="mt-4 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 p-3 text-left text-xs text-slate-400">
                  {status.log.trim()}
                </pre>
              )}
              <div className="mt-5 flex justify-center gap-2">
                <button
                  onClick={() => setRunKey((k) => k + 1)}
                  className="rounded-lg bg-sky-500 px-5 py-2 text-sm font-medium text-white"
                >
                  重新连接
                </button>
                <button onClick={() => void logout()} className="rounded-lg bg-white/10 px-5 py-2 text-sm hover:bg-white/20">
                  退出登录
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 外部 VNC 密码输入浮层：浏览器会拦截 window.prompt，所以用页面内输入框 */}
        {extPwPrompt && (
          <div className="absolute inset-0 z-40 grid place-items-center bg-black/60 px-4">
            <form
              className="w-full max-w-sm rounded-xl border border-white/10 bg-slate-900 p-5 shadow-2xl"
              onSubmit={(e) => {
                e.preventDefault();
                const pw = extPw.trim();
                if (!pw) return;
                saveExtPass(pw);
                setExtPwPrompt(false);
                setRunKey((k) => k + 1);
              }}
            >
              <div className="mb-1 text-sm font-medium text-slate-200">输入外部 VNC 桌面的密码</div>
              <div className="mb-3 text-xs leading-relaxed text-slate-400">
                这是 tigervncserver 的 VNC 密码（<code className="text-slate-300">vncpasswd</code> 设置的），不是本页面的登录密码。密码仅保存在本机浏览器。
              </div>
              <input
                autoFocus
                type="password"
                value={extPw}
                onChange={(e) => setExtPw(e.target.value)}
                placeholder="VNC 密码"
                autoComplete="off"
                className="mb-3 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-400"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="rounded-lg bg-white/10 px-4 py-2 text-sm text-slate-200 hover:bg-white/20"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!extPw.trim()}
                  className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  连接
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* 顶部工具条：退出登录 / 重新连接 / 剪贴板 */}
      <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-xs text-slate-200 shadow-lg backdrop-blur">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          外部桌面 :{EXT_VNC_PORT}
        </span>
        <button
          type="button"
          onClick={() => setClipPanel((v) => !v)}
          className={`pointer-events-auto rounded-full px-2.5 py-1 ${clipPanel ? "bg-sky-500/30 text-sky-100" : "bg-white/10 hover:bg-white/20"}`}
        >
          📋 剪贴板
        </button>
        <button
          type="button"
          onClick={() => setRunKey((k) => k + 1)}
          className="pointer-events-auto rounded-full bg-white/10 px-2.5 py-1 hover:bg-white/20"
        >
          重连
        </button>
        <button
          type="button"
          onClick={() => void logout()}
          className="pointer-events-auto rounded-full bg-red-500/20 px-2.5 py-1 text-red-200 hover:bg-red-500/40"
        >
          退出登录
        </button>
      </div>

      {/* 剪贴板面板：VNC 协议层剪贴板（远程 <-> 本机） */}
      {clipPanel && (
        <div className="absolute right-3 top-14 z-30 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-white/10 bg-slate-900/95 p-4 text-sm text-slate-200 shadow-2xl backdrop-blur">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-medium">剪贴板</span>
            <button
              type="button"
              onClick={() => setClipPanel(false)}
              className="rounded px-1.5 text-slate-400 hover:bg-white/10 hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="mb-1 text-xs text-slate-400">远程桌面复制的内容（自动接收）</div>
          <div className="mb-2 min-h-[2.5rem] rounded-lg bg-black/40 p-2 text-xs break-all whitespace-pre-wrap text-slate-300">
            {remoteClip || "在远程桌面里复制（Ctrl+C）后，内容会出现在这里"}
          </div>
          <button
            type="button"
            onClick={async () => {
              const ok = await writeLocalClipboard(remoteClip);
              setClipMsg(ok ? "已复制到本机剪贴板" : "复制失败：请手动选中上面的内容复制");
            }}
            disabled={!remoteClip}
            className="mb-3 w-full rounded-lg bg-white/10 py-1.5 text-xs hover:bg-white/20 disabled:opacity-40"
          >
            复制到本机
          </button>

          <div className="mb-1 text-xs text-slate-400">发送到远程桌面</div>
          <textarea
            value={sendText}
            onChange={(e) => setSendText(e.target.value)}
            onFocus={() => setClipMsg("")}
            rows={3}
            placeholder={
              isSecureCtx
                ? "本机复制后点「读取本机剪贴板」，或直接 Ctrl+V 粘贴后发送"
                : "在本机复制内容后，在这里 Ctrl+V 粘贴，再点发送"
            }
            className="mb-2 w-full resize-none rounded-lg border border-white/10 bg-black/40 p-2 text-xs text-slate-100 outline-none focus:border-sky-400"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={async () => {
                const t = await readLocalClipboard();
                if (t) {
                  setSendText(t);
                  setClipMsg("已读取本机剪贴板，点「发送到远程」");
                } else {
                  setClipMsg("浏览器未授权读取本机剪贴板：请在本机复制后，直接 Ctrl+V 粘贴到输入框");
                }
              }}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"
            >
              读取本机剪贴板
            </button>
            <button
              type="button"
              onClick={() => {
                if (!sendText) return;
                try {
                  rfbRef.current?.clipboardPasteFrom?.(sendText);
                  setClipMsg("已发送到远程桌面，在远程按 Ctrl+V 粘贴");
                } catch {
                  setClipMsg("发送失败");
                }
              }}
              disabled={!sendText}
              className="ml-auto rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-40"
            >
              发送到远程
            </button>
          </div>
          {clipMsg && <div className="mt-2 text-xs text-sky-300">{clipMsg}</div>}
        </div>
      )}
    </div>
  );
}
