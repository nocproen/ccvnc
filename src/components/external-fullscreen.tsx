"use client";

// 全屏远程桌面（XFCE4）：登录后直接全屏显示 VNC 桌面。
// 功能：实时延迟显示 / 本机 ↔ 远程剪贴板快捷键互通 / 本机 ↔ 远程文件互传。
import { useCallback, useEffect, useRef, useState } from "react";
import { withDesktopAccess } from "./desktop/client-session";

// 远程桌面端口：构建时可用 NEXT_PUBLIC_EXT_VNC_PORT 覆盖，默认 5901（显示器 :1）
const EXT_VNC_PORT = Number(process.env.NEXT_PUBLIC_EXT_VNC_PORT ?? 5901);

type Status = {
  state: "preparing" | "starting" | "running" | "exited" | "failed";
  note: string;
  log: string;
  exitCode: number | null;
  name: string;
  rtt?: number;
};

type Rfb = {
  disconnect(): void;
  focus(): void;
  addEventListener(type: string, cb: (e: CustomEvent) => void): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  scaleViewport: boolean;
  resizeSession: boolean;
  showDotCursor: boolean;
  qualityLevel: number;
  compressionLevel: number;
  background: string;
  clipboardPasteFrom(text: string): void;
};
type RfbCtor = new (target: HTMLElement, url: string, opts?: object) => Rfb;

type Entry = { name: string; path: string; dir: boolean; size: number; mtime: number };
type Listing = { dir: string; parent: string | null; home: string; desktop: string; entries: Entry[] };

const XK_CONTROL_L = 0xffe3;
const XK_SHIFT_L = 0xffe1;
const XK_V = 0x0076;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EXT_PASS_KEY = "webdesk.extvnc.password";
const AUTO_SYNC_KEY = "webdesk.clip.autosync";
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

async function loadRfb(): Promise<RfbCtor> {
  const url = "/novnc/core/rfb.js";
  const mod = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url);
  return mod.default as RfbCtor;
}

function fallbackCopy(text: string): boolean {
  try {
    const active = document.activeElement as HTMLElement | null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    active?.focus?.();
    return ok;
  } catch {
    return false;
  }
}
async function writeLocalClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 退回 execCommand */
  }
  return fallbackCopy(text);
}
async function readLocalClipboard(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) return (await navigator.clipboard.readText()) || "";
  } catch {
    /* 无权限 */
  }
  return "";
}

async function getStatus(sid: string): Promise<Status | "error"> {
  try {
    // 高延迟链路和沙箱唤醒期间不能将慢响应误判为会话结束。
    const r = await fetch(`/api/gui/${sid}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return "error";
    return (await r.json()) as Status;
  } catch {
    return "error";
  }
}

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function latencyColor(ms: number) {
  return ms < 80 ? "#4ade80" : ms < 150 ? "#facc15" : ms < 300 ? "#fb923c" : "#f87171";
}

function downloadPath(p: string) {
  const a = document.createElement("a");
  a.href = withDesktopAccess(`/api/sys/download?path=${encodeURIComponent(p)}`);
  a.download = "";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function ExternalFullscreen({ onExit }: { onExit: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const pasteCatcherRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rfbRef = useRef<Rfb | null>(null);
  const sidRef = useRef<string | null>(null);
  const remoteClipRef = useRef("");
  const pendingCopyUntil = useRef(0);
  const pasteModsRef = useRef<{ shift: boolean }>({ shift: false });
  const autoSyncRef = useRef(true);

  const [phase, setPhase] = useState<"preparing" | "running" | "ended">("preparing");
  const [err, setErr] = useState("");
  const [runKey, setRunKey] = useState(0);
  const [reconnecting, setReconnecting] = useState(false);
  const [frozen, setFrozen] = useState(false);
  const [extPw, setExtPw] = useState("");
  const [extPwPrompt, setExtPwPrompt] = useState(false);
  const [sid, setSid] = useState<string | null>(null);

  // 延迟：客户端实测（HTTP 往返）+ 服务端实测（WebSocket 链路）
  const [latency, setLatency] = useState<{ client: number; server: number } | null>(null);
  const [latHistory, setLatHistory] = useState<number[]>([]);

  const [toolbarMin, setToolbarMin] = useState(false);
  const [panel, setPanel] = useState<"" | "clip" | "files" | "help">("");
  const [remoteClip, setRemoteClip] = useState("");
  const [sendText, setSendText] = useState("");
  const [autoSync, setAutoSync] = useState(true);
  const [toast, setToast] = useState<{ text: string; files?: Entry[] } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [listing, setListing] = useState<Listing | null>(null);
  const [listErr, setListErr] = useState("");
  const [uploading, setUploading] = useState<string>("");
  const [dragOver, setDragOver] = useState(false);
  const [clipFiles, setClipFiles] = useState<Entry[]>([]);

  const showToast = useCallback((text: string, files?: Entry[], ms = 3500) => {
    clearTimeout(toastTimer.current);
    setToast({ text, files });
    toastTimer.current = setTimeout(() => setToast(null), files?.length ? 12_000 : ms);
  }, []);

  useEffect(() => {
    try {
      const v = localStorage.getItem(AUTO_SYNC_KEY);
      if (v !== null) {
        autoSyncRef.current = v === "1";
        setAutoSync(v === "1");
      }
    } catch {
      /* ignore */
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", keepalive: true, cache: "no-store" }).catch(() => {});
    onExit();
  }, [onExit]);

  /* ---------------- 文件互传 ---------------- */

  const loadDir = useCallback(async (dir?: string) => {
    const s = sidRef.current;
    if (!s) return;
    setListErr("");
    try {
      const r = await fetch(`/api/gui/${s}/transfer?action=list${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`);
      const d = (await r.json()) as Listing & { error?: string };
      if (!r.ok) return setListErr(d.error ?? "读取失败");
      setListing(d);
    } catch {
      setListErr("网络错误");
    }
  }, []);

  const uploadFiles = useCallback(
    async (files: File[], dir?: string): Promise<string[]> => {
      const s = sidRef.current;
      if (!s || !files.length) return [];
      const saved: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setUploading(`正在上传 ${f.name}（${i + 1}/${files.length}）…`);
        try {
          const r = await fetch(
            `/api/gui/${s}/transfer?name=${encodeURIComponent(f.name)}${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`,
            { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f },
          );
          const d = (await r.json().catch(() => ({}))) as { path?: string; error?: string };
          if (r.ok && d.path) saved.push(d.path);
          else showToast(`上传失败：${d.error ?? f.name}`);
        } catch {
          showToast(`上传失败：${f.name}`);
        }
      }
      setUploading("");
      if (saved.length) {
        // 同时放进远程剪贴板：在远程文件管理器里 Ctrl+V 即可粘贴到任意文件夹
        void fetch(`/api/gui/${s}/clipboard`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: saved }),
        }).catch(() => {});
        showToast(`已传到远程桌面（${saved.length} 个文件），也可在远程文件管理器中 Ctrl+V 粘贴`);
        void loadDir(dir ?? listing?.dir);
      }
      return saved;
    },
    [listing?.dir, loadDir, showToast],
  );

  const fetchRemoteClipFiles = useCallback(
    async (silentIfEmpty = false) => {
      const s = sidRef.current;
      if (!s) return;
      try {
        const r = await fetch(`/api/gui/${s}/transfer?action=clip`);
        const d = (await r.json()) as { kind: string; files: Entry[]; text: string };
        if (d.files?.length) {
          setClipFiles(d.files);
          showToast(`远程复制了 ${d.files.length} 个文件，点击下载到本机：`, d.files);
        } else {
          setClipFiles([]);
          if (!silentIfEmpty) showToast("远程剪贴板里没有文件：先在远程文件管理器中选中文件按 Ctrl+C");
        }
      } catch {
        if (!silentIfEmpty) showToast("读取远程剪贴板失败");
      }
    },
    [showToast],
  );

  /** 把本机剪贴板 / 粘贴事件里的内容送进远程，并在远程按下 Ctrl+V（或 Ctrl+Shift+V） */
  const pushToRemoteAndPaste = useCallback(
    async (text: string, files: File[], shift: boolean) => {
      const r = rfbRef.current;
      const s = sidRef.current;
      if (!r || !s) return;
      if (files.length) {
        const saved = await uploadFiles(files);
        if (saved.length) {
          await fetch(`/api/gui/${s}/clipboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paths: saved, triggerPaste: false }),
          }).catch(() => {});
        }
        r.focus();
        return;
      }
      if (text) {
        r.clipboardPasteFrom(text);
        remoteClipRef.current = text;
        await sleep(80);
      }
      // 在远程按下粘贴组合键（终端用 Ctrl+Shift+V）
      r.sendKey(XK_CONTROL_L, "ControlLeft", true);
      if (shift) r.sendKey(XK_SHIFT_L, "ShiftLeft", true);
      r.sendKey(XK_V, "KeyV", true);
      r.sendKey(XK_V, "KeyV", false);
      if (shift) r.sendKey(XK_SHIFT_L, "ShiftLeft", false);
      r.sendKey(XK_CONTROL_L, "ControlLeft", false);
      r.focus();
    },
    [uploadFiles],
  );

  /* ---------------- 主连接流程 ---------------- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    let sidLocal: string | null = null;
    let rfb: Rfb | null = null;
    let serverPw = "";
    let connectedAt = 0;
    let failedConnects = 0;
    let pingBusy = false;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let paintTimer: ReturnType<typeof setInterval> | undefined;

    const hasFrame = (element: HTMLElement | null) => {
      const canvas = element?.querySelector("canvas");
      if (!canvas || !canvas.width || !canvas.height) return false;
      try {
        const ctx = canvas.getContext("2d");
        const pixel = ctx?.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
        return !!pixel && pixel[3] > 0;
      } catch {
        return false;
      }
    };
    const releaseFrame = () => {
      clearInterval(paintTimer);
      ghostRef.current?.replaceChildren();
      if (!dead) setFrozen(false);
    };
    const keepFrame = (screen: HTMLElement | null) => {
      const ghost = ghostRef.current;
      if (!ghost || !screen || !hasFrame(screen)) return;
      clearInterval(paintTimer);
      ghost.replaceChildren(screen);
      setFrozen(true);
    };
    const releaseWhenPainted = () => {
      if (!ghostRef.current?.firstChild) return;
      clearInterval(paintTimer);
      const start = Date.now();
      paintTimer = setInterval(() => {
        if (dead || hasFrame(host) || Date.now() - start > 45_000) releaseFrame();
      }, 250);
    };

    const end = (message: string) => {
      if (dead) return;
      releaseFrame();
      setErr(message);
      setReconnecting(false);
      setPhase("ended");
    };

    const ping = async () => {
      const s = sidLocal;
      if (!s || dead || document.hidden || pingBusy) return;
      pingBusy = true;
      const t0 = performance.now();
      const st = await getStatus(s);
      const ms = Math.round(performance.now() - t0);
      pingBusy = false;
      if (dead || st === "error") return;
      const r = rfbRef.current;
      // 先收完首屏再考虑提画质：在 300ms+ 链路上反复切换编码会触发整屏重传。
      if (r && Date.now() - connectedAt >= 20_000) {
        const roundTrip = Math.max(ms, st.rtt ?? 0);
        const profile = roundTrip >= 250 ? { q: 0, c: 9 } : roundTrip >= 150 ? { q: 1, c: 8 } : roundTrip >= 80 ? { q: 2, c: 7 } : { q: 4, c: 4 };
        if (r.compressionLevel !== profile.c) r.compressionLevel = profile.c;
        if (r.qualityLevel !== profile.q) r.qualityLevel = profile.q;
      }
      setLatency({ client: ms, server: Math.round(st.rtt ?? 0) });
      setLatHistory((h) => [...h.slice(-29), ms]);
    };

    const connect = async () => {
      let RFB: RfbCtor;
      try {
        RFB = await loadRfb();
      } catch {
        return end("无法加载远程桌面组件");
      }
      if (dead) return;
      const pw = serverPw || getStoredExtPass();
      if (!pw) {
        setExtPwPrompt(true);
        return;
      }
      host.innerHTML = "";
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const r = new RFB(host, withDesktopAccess(`${proto}://${location.host}/api/gui/ws?sid=${sidLocal}`), {
        shared: true,
        credentials: { password: pw },
      });
      const screen = host.firstElementChild as HTMLElement | null;
      rfb = r;
      rfbRef.current = r;
      // 固定服务端 1360×768，浏览器只在本地缩放。远端改尺寸会清空帧缓冲并导致慢网反复黑屏。
      r.scaleViewport = true;
      r.resizeSession = false;
      r.showDotCursor = false;
      r.background = "#0b1120";
      r.qualityLevel = 0;
      r.compressionLevel = 9;
      let authFailed = false;
      const promptForPassword = () => {
        authFailed = true;
        saveExtPass("");
        setExtPwPrompt(true);
      };
      r.addEventListener("credentialsrequired", promptForPassword);
      r.addEventListener("securityfailure", promptForPassword);
      let connected = false;
      // 代理唤醒、握手与 300ms+ RTT 叠加时 12 秒不足以证明密码错误。
      const connTimer = setTimeout(() => {
        if (!connected && rfb === r) r.disconnect();
      }, 30_000);
      r.addEventListener("connect", () => {
        connected = true;
        failedConnects = 0;
        clearTimeout(connTimer);
        connectedAt = Date.now();
        setReconnecting(false);
        setPhase("running");
        r.focus();
        clearInterval(pingTimer);
        pingTimer = setInterval(() => void ping(), 5000);
        void ping();
        releaseWhenPainted();
      });
      // 远程复制的文本：自动同步到本机剪贴板（或在复制快捷键后的短时间内同步）
      r.addEventListener("clipboard", (e) => {
        const text = (e.detail as { text?: string } | undefined)?.text;
        if (!text || text === remoteClipRef.current) return;
        remoteClipRef.current = text;
        setRemoteClip(text);
        if (autoSyncRef.current || Date.now() < pendingCopyUntil.current) {
          void writeLocalClipboard(text).then((ok) => {
            if (ok) showToast(`已复制到本机剪贴板：${text.length > 40 ? text.slice(0, 40) + "…" : text}`, undefined, 2000);
          });
        }
      });
      r.addEventListener("disconnect", async () => {
        clearTimeout(connTimer);
        clearInterval(pingTimer);
        if (dead) return;
        if (rfbRef.current === r) rfbRef.current = null;
        if (authFailed) return; // 只有 noVNC 明确报告认证失败才重新询问密码
        if (connected) keepFrame(screen);
        setReconnecting(true);
        // 已连接较久的会话遇到代理断线，服务器仍在：等旧连接释放后再握手。
        if (connected && Date.now() - connectedAt > 8000) {
          await sleep(1500);
          if (!dead) void connect();
          return;
        }
        let wait = 1200;
        for (;;) {
          const st = sidLocal ? await getStatus(sidLocal) : "error";
          if (dead) return;
          if (st !== "error" && st.state === "running") {
            // 连握手都没走完时限速重试，避免代理持续超时造成请求风暴。
            if (!connected) {
              failedConnects++;
              await sleep(Math.min(1000 + failedConnects * 1200, 8000));
              if (dead) return;
            }
            void connect();
            return;
          }
          if (st !== "error" && (st.state === "failed" || st.state === "exited")) {
            return end(st.state === "failed" ? st.note || "连接失败" : "会话已结束");
          }
          await sleep(wait);
          if (dead) return;
          wait = Math.min(wait * 1.6, document.hidden ? 45_000 : 15_000);
        }
      });
    };

    (async () => {
      setPhase("preparing");
      setFrozen(false);
      setErr("");
      setLatency(null);
      try {
        const res = await fetch("/api/gui", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ external: { port: EXT_VNC_PORT }, name: "远程桌面", w: 1360, h: 768 }),
        });
        const d = (await res.json().catch(() => ({}))) as { sid?: string; error?: string; password?: string };
        if (!res.ok || !d.sid) return end(d.error ?? "连接失败");
        sidLocal = d.sid;
        sidRef.current = d.sid;
        setSid(d.sid);
        serverPw = d.password ?? "";
        for (;;) {
          const st = await getStatus(sidLocal);
          if (dead) return;
          if (st === "error") {
            await sleep(700);
            continue;
          }
          if (st.state === "running") break;
          if (st.state === "exited" || st.state === "failed") {
            return end(st.state === "failed" ? st.note || "连接失败" : "会话已结束");
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
      clearInterval(pingTimer);
      clearInterval(paintTimer);
      ghostRef.current?.replaceChildren();
      rfb?.disconnect();
      rfbRef.current = null;
      if (sidLocal) void fetch(`/api/gui/${sidLocal}`, { method: "DELETE", keepalive: true }).catch(() => {});
      sidRef.current = null;
      host.innerHTML = "";
    };
  }, [runKey, showToast]);

  /* ---------------- 快捷键：剪贴板与文件 ---------------- */

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!rfbRef.current) return;
      const target = ev.target as HTMLElement | null;
      // 工具面板里的输入框正常使用浏览器行为
      if (target && target !== pasteCatcherRef.current && target.closest?.("[data-wd-ui]")) return;
      const key = ev.key.toLowerCase();
      const ctrl = ev.ctrlKey || ev.metaKey;

      // 粘贴：Ctrl+V / Ctrl+Shift+V / Shift+Insert / Alt+V —— 只粘本机剪贴板（文本 / 图片 / 文件）
      const isPaste =
        (ctrl && !ev.altKey && key === "v") || (ev.shiftKey && !ctrl && key === "insert") || (ev.altKey && !ctrl && key === "v");
      if (isPaste) {
        const catcher = pasteCatcherRef.current;
        if (!catcher) return;
        ev.stopImmediatePropagation(); // 不交给 noVNC
        pasteModsRef.current = { shift: ctrl && ev.shiftKey };
        if (ev.altKey) {
          // Alt+V：浏览器没有原生粘贴事件，走 Clipboard API
          ev.preventDefault();
          void readLocalClipboard().then((t) => {
            if (t) void pushToRemoteAndPaste(t, [], false);
            else showToast("浏览器未授权读取剪贴板：请改用 Ctrl+V");
          });
          return;
        }
        // 让浏览器把内容粘进隐藏输入框，从 paste 事件里拿到文本和文件（http 部署也可用）
        catcher.value = "";
        catcher.focus();
        return;
      }

      // 复制：Ctrl+Shift+C / Alt+C → 把远程选中内容复制到本机
      if ((ctrl && ev.shiftKey && key === "c") || (ev.altKey && !ctrl && key === "c")) {
        pendingCopyUntil.current = Date.now() + 2500;
        if (ev.altKey) {
          // Alt+C：替用户在远程按 Ctrl+C
          ev.preventDefault();
          ev.stopImmediatePropagation();
          const r = rfbRef.current;
          r.sendKey(XK_CONTROL_L, "ControlLeft", true);
          r.sendKey(0x0063, "KeyC", true);
          r.sendKey(0x0063, "KeyC", false);
          r.sendKey(XK_CONTROL_L, "ControlLeft", false);
        }
        // 文件管理器里复制的是文件：稍等一下再去读远程剪贴板里的文件列表
        setTimeout(() => void fetchRemoteClipFiles(true), 450);
        return;
      }
      // 普通 Ctrl+C：照常交给远程，同时在短时间内把复制结果同步到本机
      if (ctrl && !ev.shiftKey && key === "c") {
        pendingCopyUntil.current = Date.now() + 2500;
        setTimeout(() => void fetchRemoteClipFiles(true), 450);
        return;
      }
      // Ctrl+Shift+D：下载远程复制的文件
      if (ctrl && ev.shiftKey && key === "d") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        void fetchRemoteClipFiles(false);
        return;
      }
      // Ctrl+Shift+U：上传本机文件到远程桌面
      if (ctrl && ev.shiftKey && key === "u") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        fileInputRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [fetchRemoteClipFiles, pushToRemoteAndPaste, showToast]);

  const onCatcherPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    const files = Array.from(e.clipboardData.files ?? []);
    pasteCatcherRef.current?.blur();
    void pushToRemoteAndPaste(files.length ? "" : text, files, pasteModsRef.current.shift);
  };

  useEffect(() => {
    if (panel === "files" && sid) void loadDir(listing?.dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, sid]);

  const avgLat = latHistory.length ? Math.round(latHistory.reduce((a, b) => a + b, 0) / latHistory.length) : 0;
  const shownLat = latency ? (latency.server > 0 ? Math.min(latency.client, latency.server) || latency.client : latency.client) : 0;

  return (
    <div className="fixed inset-0 flex flex-col bg-[#0b1120] text-white">
      {/* 隐藏的粘贴接收框：Ctrl+V 时临时获得焦点，拿到本机剪贴板的文本 / 文件 */}
      <textarea
        ref={pasteCatcherRef}
        aria-hidden
        tabIndex={-1}
        onPaste={onCatcherPaste}
        onBlur={(e) => (e.currentTarget.value = "")}
        className="pointer-events-none fixed left-0 top-0 h-px w-px opacity-0"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void uploadFiles(files, panel === "files" ? listing?.dir : undefined);
        }}
      />

      {/* VNC 画面 */}
      <div
        className="relative min-h-0 flex-1"
        onDragOver={(e) => {
          if (phase !== "running" || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          setDragOver(false);
          void uploadFiles(Array.from(e.dataTransfer.files));
        }}
      >
        <div ref={hostRef} className="absolute inset-0" />
        <div ref={ghostRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden="true" />

        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center border-4 border-dashed border-sky-400 bg-sky-500/10">
            <div className="rounded-full bg-black/70 px-5 py-2 text-sm shadow-lg">松开鼠标，把文件传到远程桌面</div>
          </div>
        )}

        {phase === "preparing" && (
          <div className="absolute inset-0 grid place-items-center bg-[#0b1120] px-6 text-center text-slate-300">
            <div>
              <div className="mx-auto mb-4 h-9 w-9 animate-spin rounded-full border-2 border-white/20 border-t-sky-400" />
              <div className="text-sm">正在连接桌面…</div>
            </div>
          </div>
        )}

        {frozen && phase === "running" && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
            <div className="flex items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-xs text-slate-200 shadow-lg backdrop-blur">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/20 border-t-sky-400" />
              {reconnecting ? "网络波动，正在重连（显示上次画面）…" : "已恢复连接，等待最新画面…"}
            </div>
          </div>
        )}
        {reconnecting && !frozen && phase === "running" && (
          <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
            <div className="rounded-xl bg-black/60 px-6 py-4 text-center text-slate-200 shadow-lg backdrop-blur">
              <div className="mx-auto mb-3 h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-sky-400" />
              <div className="text-sm">连接中断，正在重新连接…</div>
            </div>
          </div>
        )}

        {phase === "ended" && (
          <div className="absolute inset-0 grid place-items-center bg-[#0b1120] px-6 py-8 text-slate-300">
            <div className="mx-auto max-w-xl text-center">
              <div className="mb-2 text-4xl">⚠️</div>
              <div className="text-sm">{err || "会话已结束"}</div>
              <div className="mt-5 flex justify-center gap-2">
                <button onClick={() => setRunKey((k) => k + 1)} className="rounded-lg bg-sky-500 px-5 py-2 text-sm font-medium text-white">
                  重新连接
                </button>
                <button onClick={() => void logout()} className="rounded-lg bg-white/10 px-5 py-2 text-sm hover:bg-white/20">
                  退出登录
                </button>
              </div>
            </div>
          </div>
        )}

        {extPwPrompt && (
          <div data-wd-ui className="absolute inset-0 z-40 grid place-items-center bg-black/60 px-4">
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
              <div className="mb-3 text-sm font-medium text-slate-200">输入远程桌面密码</div>
              <input
                autoFocus
                type="password"
                value={extPw}
                onChange={(e) => setExtPw(e.target.value)}
                placeholder="密码"
                autoComplete="off"
                className="mb-3 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-400"
              />
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => void logout()} className="rounded-lg bg-white/10 px-4 py-2 text-sm text-slate-200 hover:bg-white/20">
                  取消
                </button>
                <button type="submit" disabled={!extPw.trim()} className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-40">
                  连接
                </button>
              </div>
            </form>
          </div>
        )}
      </div>

      {/* 顶部工具条：延迟 / 剪贴板 / 文件 / 快捷键 / 重连 / 退出 */}
      {phase !== "ended" && (
        <div
          data-wd-ui
          onMouseDown={(e) => e.preventDefault()}
          className="absolute left-1/2 top-2 z-30 flex -translate-x-1/2 select-none items-center gap-1.5 rounded-full bg-black/60 px-2 py-1 text-xs text-slate-200 shadow-lg backdrop-blur"
        >
          <span
            className="flex items-center gap-1.5 rounded-full px-2 py-1 font-mono tabular-nums"
            title={
              latency
                ? `本机 ↔ 服务器往返：${latency.client}ms\n画面链路往返：${latency.server || "—"}ms\n最近 1 分钟平均：${avgLat}ms`
                : "正在测量延迟"
            }
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: latency ? latencyColor(shownLat) : "#64748b" }} />
            {latency ? `延迟 ${shownLat}ms` : "延迟 —"}
          </span>
          {!toolbarMin && (
            <>
              <ToolBtn active={panel === "clip"} onClick={() => setPanel((p) => (p === "clip" ? "" : "clip"))}>
                📋 剪贴板
              </ToolBtn>
              <ToolBtn active={panel === "files"} onClick={() => setPanel((p) => (p === "files" ? "" : "files"))}>
                📁 文件
              </ToolBtn>
              <ToolBtn active={panel === "help"} onClick={() => setPanel((p) => (p === "help" ? "" : "help"))}>
                ⌨ 快捷键
              </ToolBtn>
              <ToolBtn onClick={() => setRunKey((k) => k + 1)}>重连</ToolBtn>
              <button
                type="button"
                onClick={() => void logout()}
                className="rounded-full bg-red-500/20 px-2.5 py-1 text-red-200 hover:bg-red-500/40"
              >
                退出
              </button>
            </>
          )}
          <button
            type="button"
            title={toolbarMin ? "展开工具条" : "收起工具条（只显示延迟）"}
            onClick={() => {
              setToolbarMin((v) => !v);
              setPanel("");
              rfbRef.current?.focus();
            }}
            className="rounded-full px-1.5 py-1 text-slate-400 hover:bg-white/10 hover:text-white"
          >
            {toolbarMin ? "›" : "‹"}
          </button>
        </div>
      )}

      {/* 剪贴板面板 */}
      {panel === "clip" && (
        <Panel title="剪贴板" onClose={() => setPanel("")}>
          <label className="mb-3 flex cursor-pointer items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(e) => {
                autoSyncRef.current = e.target.checked;
                setAutoSync(e.target.checked);
                try {
                  localStorage.setItem(AUTO_SYNC_KEY, e.target.checked ? "1" : "0");
                } catch {
                  /* ignore */
                }
              }}
            />
            远程复制的文字自动同步到本机剪贴板
          </label>
          <div className="mb-1 text-xs text-slate-400">远程最近复制的文字</div>
          <div className="mb-2 max-h-28 min-h-[2.5rem] overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 p-2 text-xs text-slate-300">
            {remoteClip || "在远程桌面里复制后，内容会出现在这里"}
          </div>
          <button
            type="button"
            disabled={!remoteClip}
            onClick={async () => showToast((await writeLocalClipboard(remoteClip)) ? "已复制到本机剪贴板" : "复制失败，请手动选中复制")}
            className="mb-4 w-full rounded-lg bg-white/10 py-1.5 text-xs hover:bg-white/20 disabled:opacity-40"
          >
            复制到本机
          </button>

          <div className="mb-1 text-xs text-slate-400">发送文字到远程（也可以直接在画面里按 Ctrl+V）</div>
          <textarea
            value={sendText}
            onChange={(e) => setSendText(e.target.value)}
            rows={3}
            placeholder="在这里粘贴或输入文字"
            className="mb-2 w-full resize-none rounded-lg border border-white/10 bg-black/40 p-2 text-xs text-slate-100 outline-none focus:border-sky-400"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={async () => {
                const t = await readLocalClipboard();
                if (t) setSendText(t);
                else showToast("浏览器未授权读取剪贴板：请在输入框里 Ctrl+V");
              }}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/20"
            >
              读取本机剪贴板
            </button>
            <button
              type="button"
              disabled={!sendText}
              onClick={() => {
                void pushToRemoteAndPaste(sendText, [], false);
                showToast("已粘贴到远程");
              }}
              className="ml-auto rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-40"
            >
              粘贴到远程
            </button>
          </div>

          <div className="mt-4 border-t border-white/10 pt-3">
            <div className="mb-1 flex items-center justify-between text-xs text-slate-400">
              <span>远程复制的文件</span>
              <button type="button" onClick={() => void fetchRemoteClipFiles(false)} className="text-sky-300 hover:text-sky-200">
                刷新
              </button>
            </div>
            {clipFiles.length === 0 ? (
              <div className="text-xs text-slate-500">在远程文件管理器中选中文件按 Ctrl+C，再点「刷新」或按 Ctrl+Shift+D</div>
            ) : (
              <FileList entries={clipFiles} />
            )}
          </div>
        </Panel>
      )}

      {/* 文件面板 */}
      {panel === "files" && (
        <Panel title="文件互传" onClose={() => setPanel("")} wide>
          <div className="mb-2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-400"
            >
              ⬆ 上传到此文件夹
            </button>
            <button type="button" onClick={() => void loadDir(listing?.desktop)} className="rounded-lg bg-white/10 px-2.5 py-1.5 text-xs hover:bg-white/20">
              桌面
            </button>
            <button type="button" onClick={() => void loadDir(listing?.home)} className="rounded-lg bg-white/10 px-2.5 py-1.5 text-xs hover:bg-white/20">
              主目录
            </button>
            <button type="button" onClick={() => void loadDir(listing?.dir)} className="ml-auto rounded-lg bg-white/10 px-2.5 py-1.5 text-xs hover:bg-white/20">
              刷新
            </button>
          </div>
          {uploading && <div className="mb-2 text-xs text-sky-300">{uploading}</div>}
          <div className="mb-2 flex items-center gap-1 truncate text-xs text-slate-400">
            {listing?.parent && (
              <button type="button" onClick={() => void loadDir(listing.parent!)} className="rounded bg-white/10 px-1.5 hover:bg-white/20">
                ↑
              </button>
            )}
            <span className="truncate" title={listing?.dir}>
              {listing?.dir ?? "加载中…"}
            </span>
          </div>
          {listErr && <div className="mb-2 text-xs text-red-300">{listErr}</div>}
          <div className="max-h-[50vh] overflow-auto rounded-lg bg-black/30">
            {listing && listing.entries.length === 0 && <div className="p-3 text-xs text-slate-500">空文件夹：把本机文件拖到画面上即可上传</div>}
            {listing?.entries.map((en) => (
              <div key={en.path} className="flex items-center gap-2 border-b border-white/5 px-2 py-1.5 text-xs last:border-0 hover:bg-white/5">
                <span>{en.dir ? "📁" : "📄"}</span>
                {en.dir ? (
                  <button type="button" onClick={() => void loadDir(en.path)} className="min-w-0 flex-1 truncate text-left hover:text-sky-300">
                    {en.name}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate">{en.name}</span>
                )}
                {!en.dir && <span className="shrink-0 text-slate-500">{fmtSize(en.size)}</span>}
                <button
                  type="button"
                  title={en.dir ? "打包为 zip 下载到本机" : "下载到本机"}
                  onClick={() => downloadPath(en.path)}
                  className="shrink-0 rounded bg-white/10 px-2 py-0.5 hover:bg-sky-500/60"
                >
                  ⬇
                </button>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11px] leading-relaxed text-slate-500">
            本机 → 远程：拖文件到画面上、在画面里 Ctrl+V 粘贴文件，或点「上传」。远程 → 本机：点 ⬇ 下载，或在远程文件管理器中 Ctrl+C 后按 Ctrl+Shift+D。
          </div>
        </Panel>
      )}

      {/* 快捷键说明 */}
      {panel === "help" && (
        <Panel title="快捷键" onClose={() => setPanel("")}>
          <table className="w-full text-xs">
            <tbody className="[&_td]:py-1.5 [&_td:first-child]:pr-3 [&_td:first-child]:font-mono [&_td:first-child]:whitespace-nowrap [&_td:first-child]:text-sky-300">
              <tr><td>Ctrl+V</td><td>把本机剪贴板（文字 / 图片 / 文件）粘贴到远程</td></tr>
              <tr><td>Ctrl+Shift+V</td><td>同上，远程按 Ctrl+Shift+V（适合终端）</td></tr>
              <tr><td>Alt+V / Shift+Ins</td><td>粘贴本机文字到远程（备用）</td></tr>
              <tr><td>Ctrl+C</td><td>远程复制，并自动同步到本机剪贴板</td></tr>
              <tr><td>Ctrl+Shift+C</td><td>终端里复制，并同步到本机</td></tr>
              <tr><td>Alt+C</td><td>替你在远程按 Ctrl+C 并同步到本机（备用）</td></tr>
              <tr><td>Ctrl+Shift+D</td><td>下载远程文件管理器里复制（Ctrl+C）的文件</td></tr>
              <tr><td>Ctrl+Shift+U</td><td>选择本机文件上传到远程桌面</td></tr>
              <tr><td>拖放</td><td>把本机文件拖到画面上 → 出现在远程桌面</td></tr>
            </tbody>
          </table>
        </Panel>
      )}

      {/* 提示 */}
      {toast && (
        <div data-wd-ui className="absolute bottom-4 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-xl bg-black/80 px-4 py-2.5 text-xs text-slate-100 shadow-xl backdrop-blur">
          <div className="flex items-start gap-3">
            <span className="break-all">{toast.text}</span>
            <button type="button" onClick={() => setToast(null)} className="text-slate-400 hover:text-white">
              ✕
            </button>
          </div>
          {toast.files && toast.files.length > 0 && (
            <div className="mt-2">
              <FileList entries={toast.files} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolBtn({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full px-2.5 py-1 ${active ? "bg-sky-500/30 text-sky-100" : "bg-white/10 hover:bg-white/20"}`}
    >
      {children}
    </button>
  );
}

function Panel({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div
      data-wd-ui
      className={`absolute right-3 top-14 z-30 ${wide ? "w-[28rem]" : "w-80"} max-w-[calc(100vw-1.5rem)] rounded-xl border border-white/10 bg-slate-900/95 p-4 text-sm text-slate-200 shadow-2xl backdrop-blur`}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="font-medium">{title}</span>
        <button type="button" onClick={onClose} className="rounded px-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

function FileList({ entries }: { entries: Entry[] }) {
  return (
    <div className="max-h-48 space-y-1 overflow-auto">
      {entries.map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={() => downloadPath(f.path)}
          className="flex w-full items-center gap-2 rounded-lg bg-white/10 px-2 py-1.5 text-left text-xs hover:bg-sky-500/50"
        >
          <span>{f.dir ? "📁" : "📄"}</span>
          <span className="min-w-0 flex-1 truncate">{f.name}</span>
          <span className="shrink-0 text-slate-400">{f.dir ? "zip" : fmtSize(f.size)}</span>
          <span>⬇</span>
        </button>
      ))}
    </div>
  );
}
