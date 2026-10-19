"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { subscribeLive } from "./live-sync";

export type AppId =
  | "lite"
  | "gui"
  | "browser"
  | "sysfiles"
  | "systerm"
  | "monitor"
  | "sysedit"
  | "files"
  | "notepad"
  | "terminal"
  | "settings"
  | "calculator";

export const APPS: Record<
  AppId,
  { name: string; icon: string; gradient: string; w: number; h: number; single?: boolean; hidden?: boolean }
> = {
  gui: { name: "应用", icon: "🚀", gradient: "from-fuchsia-500 to-indigo-600", w: 1000, h: 660, hidden: true },
  browser: { name: "浏览器", icon: "🌐", gradient: "from-sky-400 to-cyan-600", w: 1100, h: 700, single: true },
  lite: { name: "极速浏览器", icon: "⚡", gradient: "from-amber-400 to-orange-500", w: 1040, h: 680 },
  sysfiles: { name: "文件管理器", icon: "📂", gradient: "from-amber-400 to-orange-500", w: 820, h: 520 },
  systerm: { name: "终端", icon: "⌨️", gradient: "from-slate-600 to-slate-900", w: 720, h: 440 },
  monitor: {
    name: "系统监视器",
    icon: "📊",
    gradient: "from-rose-400 to-pink-600",
    w: 780,
    h: 520,
    single: true,
  },
  sysedit: {
    name: "文本编辑器",
    icon: "✏️",
    gradient: "from-sky-400 to-blue-600",
    w: 640,
    h: 460,
    hidden: true,
  },
  files: { name: "云盘", icon: "☁️", gradient: "from-sky-400 to-indigo-500", w: 760, h: 480 },
  notepad: { name: "云盘记事本", icon: "📝", gradient: "from-sky-400 to-blue-600", w: 560, h: 420 },
  terminal: { name: "沙盒终端", icon: "🧪", gradient: "from-violet-500 to-fuchsia-700", w: 660, h: 400 },
  settings: {
    name: "设置",
    icon: "⚙️",
    gradient: "from-slate-400 to-slate-600",
    w: 700,
    h: 480,
    single: true,
  },
  calculator: {
    name: "计算器",
    icon: "🧮",
    gradient: "from-emerald-400 to-teal-600",
    w: 320,
    h: 470,
    single: true,
  },
};

export type Win = {
  id: string;
  app: AppId;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
  folderId?: number | null;
  fileId?: number;
  path?: string;
  title?: string;
  cmd?: string;
  desktopFile?: string;
  iconUrl?: string;
  pendingUrl?: string;
  browserTabs?: string[];
  browserActiveIndex?: number;
  guiSid?: string;
  external?: { host?: string; port?: number };
};

type State = { wins: Win[]; z: number; seq: number };

type Action =
  | { type: "hydrate"; state: State }
  | { type: "open"; win: Omit<Win, "id" | "z"> }
  | { type: "focus"; id: string }
  | { type: "close"; id: string }
  | { type: "minimize"; id: string }
  | { type: "toggleMax"; id: string }
  | { type: "patch"; id: string; patch: Partial<Win> }
  | { type: "showDesktop" }
  | { type: "restoreAll" }
  | { type: "closeFile"; fileId: number };

const EMPTY: State = { wins: [], z: 10, seq: 0 };

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case "hydrate":
      return a.state;
    case "open": {
      const seq = s.seq + 1;
      const z = s.z + 1;
      return { wins: [...s.wins, { ...a.win, id: `w${seq}`, z }], z, seq };
    }
    case "focus": {
      const z = s.z + 1;
      return {
        z,
        seq: s.seq,
        wins: s.wins.map((w) => (w.id === a.id ? { ...w, z, minimized: false } : w)),
      };
    }
    case "close":
      return { ...s, wins: s.wins.filter((w) => w.id !== a.id) };
    case "closeFile":
      return { ...s, wins: s.wins.filter((w) => !(w.app === "notepad" && w.fileId === a.fileId)) };
    case "minimize":
      return { ...s, wins: s.wins.map((w) => (w.id === a.id ? { ...w, minimized: true } : w)) };
    case "toggleMax":
      return {
        ...s,
        wins: s.wins.map((w) => (w.id === a.id ? { ...w, maximized: !w.maximized } : w)),
      };
    case "patch":
      return { ...s, wins: s.wins.map((w) => (w.id === a.id ? { ...w, ...a.patch } : w)) };
    case "showDesktop":
      return { ...s, wins: s.wins.map((w) => ({ ...w, minimized: true })) };
    case "restoreAll":
      return { ...s, wins: s.wins.map((w) => ({ ...w, minimized: false })) };
  }
}

type OpenOpts = {
  folderId?: number | null;
  fileId?: number;
  path?: string;
  cmd?: string;
  desktopFile?: string;
  name?: string;
  iconUrl?: string;
  external?: { host?: string; port?: number };
};

type WmApi = {
  wins: Win[];
  focusedId: string | null;
  isMobile: boolean;
  /** 当前视口尺寸。窗口坐标按"作者当时的屏幕"保存，渲染时再按本视口裁剪。 */
  viewport: { w: number; h: number };
  open: (app: AppId, opts?: OpenOpts) => void;
  focus: (id: string) => void;
  close: (id: string) => void;
  minimize: (id: string) => void;
  toggleMax: (id: string) => void;
  patch: (id: string, patch: Partial<Win>) => void;
  showDesktop: () => void;
  closeFile: (fileId: number) => void;
  toggleApp: (app: AppId) => void;
};

const Ctx = createContext<WmApi | null>(null);

export function useWm() {
  const v = useContext(Ctx);
  if (!v) throw new Error("WmProvider missing");
  return v;
}

type WorkspaceResponse = { snapshot: State; version: number };

// 只持久化 UI 视图。文件、壁纸与真实系统目录由仓库原有 API 分别保存。
function snapshotOf(s: State): State {
  return {
    wins: s.wins.map((w) => ({ ...w, pendingUrl: undefined })),
    z: s.z,
    seq: s.seq,
  };
}

// 服务器返回的快照做一次兜底清洗：字段缺失/类型不对时不能让整个桌面崩掉
function normalizeSnapshot(input: unknown): State {
  const raw = (input ?? {}) as Partial<State>;
  const wins = (Array.isArray(raw.wins) ? raw.wins : []).filter(
    (w): w is Win =>
      !!w &&
      typeof w === "object" &&
      typeof (w as Win).id === "string" &&
      typeof (w as Win).app === "string" &&
      Object.prototype.hasOwnProperty.call(APPS, (w as Win).app),
  );
  const safe = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  return {
    wins: wins.map((w) => ({
      ...w,
      x: safe(w.x, 80),
      y: safe(w.y, 40),
      w: safe(w.w, 800),
      h: safe(w.h, 540),
      z: safe(w.z, 10),
      minimized: w.minimized === true,
      maximized: w.maximized === true,
    })),
    z: Math.max(10, safe(raw.z, 10), ...wins.map((w) => safe(w.z, 10))),
    seq: Math.max(0, safe(raw.seq, 0), ...wins.map((w) => Number(String(w.id).slice(1)) || 0)),
  };
}

/** 只保留最近 1.5 秒内的本地改动标记，过期的顺手清掉 */
function freshSet(map: Map<string, number>) {
  const now = Date.now();
  const out = new Set<string>();
  for (const [id, at] of map) {
    if (now - at < 1500) out.add(id);
    else map.delete(id);
  }
  return out;
}

/**
 * 合并两份快照：以服务器为准，但"本地刚动过"的窗口保留本地版本。
 * 没有这一步，两个网页同时操作时就会互相把对方正在拖的窗口弹回去。
 */
function mergeStates(
  remote: State,
  local: State,
  dirty: Set<string>,
  removed: Set<string>,
): State {
  const localById = new Map(local.wins.map((w) => [w.id, w]));
  const remoteIds = new Set(remote.wins.map((w) => w.id));
  const wins: Win[] = [];

  for (const rw of remote.wins) {
    // 本地刚关掉的窗口不要被旧快照复活
    if (removed.has(rw.id)) continue;
    const lw = localById.get(rw.id);
    wins.push(lw && dirty.has(rw.id) ? lw : rw);
  }
  for (const lw of local.wins) {
    // 本地新开、还没写进服务器的窗口
    if (!remoteIds.has(lw.id) && dirty.has(lw.id) && !removed.has(lw.id)) wins.push(lw);
  }

  const seq = Math.max(
    remote.seq,
    local.seq,
    ...wins.map((w) => Number(w.id.slice(1)) || 0),
  );
  return {
    wins,
    z: Math.max(remote.z, local.z, ...wins.map((w) => w.z)),
    seq,
  };
}

export function WmProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const [isMobile, setIsMobile] = useState(false);
  const [viewport, setViewport] = useState({ w: 1280, h: 800 });
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const version = useRef(0); // 服务器上最新版本号
  const pending = useRef<State | null>(null); // 待写入的快照
  const sending = useRef(false);
  const latest = useRef(state);
  const prev = useRef<State>(EMPTY);
  const lastSerialized = useRef("");
  // 本地刚改过 / 刚关掉的窗口：冲突合并时以本地为准。
  // 带时间戳是因为别人那份"写之前拍的"快照可能在我们写完之后才到，
  // 刚动过的窗口在 1.5 秒内必须压过它，否则窗口会跳回去。
  const dirty = useRef(new Map<string, number>());
  const removed = useRef(new Map<string, number>());
  const lastEditAt = useRef(0);
  const queuedRemote = useRef<State | null>(null);
  const queueTimer = useRef<number | undefined>(undefined);
  // 退出登录 / 被挤下线时组件会卸载：别再往服务器写、也别再派发状态
  const alive = useRef(true);
  latest.current = state;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(queueTimer.current);
      queuedRemote.current = null;
      pending.current = null;
    };
  }, []);

  /** 直接采用一份完整快照（来自服务器），不产生"本地改动" */
  const applyState = useCallback((next: State) => {
    prev.current = next;
    lastSerialized.current = JSON.stringify(snapshotOf(next));
    dispatch({ type: "hydrate", state: next });
  }, []);

  const flush = useCallback(async () => {
    if (!alive.current || sending.current || !pending.current) return;
    sending.current = true;
    let retryLater = false;
    try {
      let attempts = 0;
      // 409 = 别人抢先写了。合并后带着新版本号重试，最多 6 次，避免死循环。
      while (pending.current && attempts < 6) {
        attempts++;
        const working = pending.current;
        if (!working) break;
        pending.current = null;
        const serialized = JSON.stringify(working);
        let response: Response;
        try {
          response = await fetch("/api/workspace", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: version.current, snapshot: working }),
            cache: "no-store",
          });
        } catch {
          pending.current ??= working;
          retryLater = true;
          break;
        }
        if (response.status === 401) return; // 已掉线，登录界面会接管

        const data = (await response.json().catch(() => null)) as
          | { version?: number; snapshot?: unknown }
          | null;

        if (response.ok && typeof data?.version === "number") {
          version.current = data.version;
          // 写入期间又有新改动（pending 非空）时先别清标记：那批改动还没落盘
          if (!pending.current) {
            lastSerialized.current = serialized;
          }
          continue;
        }
        if (response.status === 409 && typeof data?.version === "number") {
          version.current = data.version;
          const merged = mergeStates(
            normalizeSnapshot(data.snapshot),
            latest.current,
            freshSet(dirty.current),
            freshSet(removed.current),
          );
          applyState(merged);
          pending.current = snapshotOf(merged);
          continue;
        }
        pending.current ??= working;
        retryLater = true;
        break;
      }
    } finally {
      sending.current = false;
      if (alive.current && pending.current) {
        window.setTimeout(() => void flush(), retryLater ? 1200 : 200);
      }
      // 排队的远端快照由 queueRemote 自己的定时器接手：它会在写入空闲后自动落地
    }
  }, [applyState]);

  const applyRemote = useCallback(
    (snapshot: State) => {
      const dirtyNow = freshSet(dirty.current);
      const removedNow = freshSet(removed.current);
      const merged = mergeStates(snapshot, latest.current, dirtyNow, removedNow);
      applyState(merged);
      // 本地还有没写进服务器的改动：把合并结果继续推上去，别让本地操作丢失
      if (dirtyNow.size || removedNow.size) {
        pending.current = snapshotOf(merged);
        window.setTimeout(() => void flush(), 120);
      }
    },
    [applyState, flush],
  );

  // 正在拖拽 / 缩放 / 输入时先不套用远端快照，等手停下来再合，否则窗口会"跳回去"
  const queueRemote = useCallback(
    function queue(snapshot: State) {
      queuedRemote.current = snapshot;
      window.clearTimeout(queueTimer.current);
      queueTimer.current = window.setTimeout(() => {
        if (!alive.current || !queuedRemote.current) return;
        if (sending.current || pending.current || Date.now() - lastEditAt.current < 350) {
          queue(queuedRemote.current);
          return;
        }
        const next = queuedRemote.current;
        queuedRemote.current = null;
        applyRemote(next);
      }, 400);
    },
    [applyRemote],
  );

  // 首次加载：数据库没读成功之前绝不渲染空桌面
  useEffect(() => {
    let active = true;
    const load = async () => {
      while (active) {
        try {
          const response = await fetch("/api/workspace", { cache: "no-store" });
          if (!response.ok) throw new Error("无法加载桌面快照");
          const data = (await response.json()) as WorkspaceResponse;
          if (!active) return;
          // 不做视口裁剪：窗口坐标属于所有人共享的桌面，小屏网页不该把大屏的窗口改小
          const hydrated = normalizeSnapshot(data.snapshot);
          version.current = data.version ?? 0;
          applyState(hydrated);
          setReady(true);
          return;
        } catch {
          if (!active) return;
          setLoadError(true);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [applyState]);

  // 本地改动 -> 记录脏窗口 + 防抖写入
  useEffect(() => {
    const before = prev.current;
    prev.current = state;
    if (!ready) return;

    const snapshot = snapshotOf(state);
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastSerialized.current) return;

    const beforeById = new Map(before.wins.map((w) => [w.id, w]));
    for (const w of state.wins) {
      const old = beforeById.get(w.id);
      if (!old || JSON.stringify(old) !== JSON.stringify(w)) dirty.current.set(w.id, Date.now());
      beforeById.delete(w.id);
    }
    for (const id of beforeById.keys()) removed.current.set(id, Date.now());

    lastEditAt.current = Date.now();
    lastSerialized.current = serialized;
    pending.current = snapshot;
    const timer = window.setTimeout(() => void flush(), 180);
    return () => window.clearTimeout(timer);
  }, [state, ready, flush]);

  // 其他网页 / 其他设备改了桌面：实时套用
  useEffect(() => {
    if (!ready) return;
    return subscribeLive((msg) => {
      if (msg.type !== "workspace") return;
      if (typeof msg.version !== "number" || msg.version <= version.current) return;
      version.current = msg.version;
      const snapshot = normalizeSnapshot(msg.snapshot);
      if (sending.current || pending.current || Date.now() - lastEditAt.current < 350) {
        queueRemote(snapshot);
        return;
      }
      applyRemote(snapshot);
    });
  }, [ready, applyRemote, queueRemote]);

  // 切回这个网页时补一次：后台标签页的 SSE 可能被浏览器降频甚至掐断
  useEffect(() => {
    if (!ready) return;
    let busy = false;
    const sync = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const meta = await fetch("/api/workspace?meta=1", { cache: "no-store" });
        if (!meta.ok) return;
        const { version: remoteVersion } = (await meta.json()) as { version?: number };
        if (typeof remoteVersion !== "number" || remoteVersion <= version.current) return;
        const response = await fetch("/api/workspace", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as WorkspaceResponse;
        if ((data.version ?? 0) <= version.current) return;
        version.current = data.version ?? 0;
        const snapshot = normalizeSnapshot(data.snapshot);
        if (sending.current || pending.current || Date.now() - lastEditAt.current < 350) {
          queueRemote(snapshot);
          return;
        }
        applyRemote(snapshot);
      } catch {
        // 网络抖动：等下一次 focus / 心跳
      } finally {
        busy = false;
      }
    };
    const onShow = () => void sync();
    const timer = window.setInterval(() => void sync(), 20_000);
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [ready, applyRemote, queueRemote]);

  // 关页时把最后一次改动补上。用 keepalive + 版本比对，绝不强制覆盖别人的桌面。
  useEffect(() => {
    const saveAtExit = () => {
      if (!ready) return;
      const snapshot = snapshotOf(latest.current);
      if (JSON.stringify(snapshot) === lastSerialized.current) return; // 已经落盘
      void fetch("/api/workspace", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: version.current, snapshot }),
        keepalive: true,
        cache: "no-store",
      }).catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveAtExit();
    };
    window.addEventListener("pagehide", saveAtExit);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", saveAtExit);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready]);

  useEffect(() => {
    const check = () => {
      setViewport({ w: window.innerWidth, h: window.innerHeight });
      setIsMobile(window.innerWidth < 768);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const visible = state.wins.filter((w) => !w.minimized);
  const focusedId = visible.length
    ? visible.reduce((a, b) => (b.z > a.z ? b : a)).id
    : null;

  const open = useCallback(
    (app: AppId, opts: OpenOpts = {}) => {
      const existing = state.wins.find((w) => {
        if (w.app !== app) return false;
        if (app === "notepad") return opts.fileId !== undefined && w.fileId === opts.fileId;
        if (app === "sysedit" || app === "sysfiles") return opts.path !== undefined && w.path === opts.path;
        if (app === "gui") {
          const key = opts.desktopFile ?? opts.cmd ?? (opts.external ? `external:${opts.external.port}` : undefined);
          return key !== undefined && (w.desktopFile ?? w.cmd ?? (w.external ? `external:${w.external.port}` : undefined)) === key;
        }
        if (app === "systerm") return false;
        if (app === "files") return opts.folderId !== undefined && w.folderId === opts.folderId;
        return APPS[app].single;
      });
      if (existing) {
        // 浏览器只有一个窗口：新网址交给它在新标签页打开
        if (app === "browser" && opts.path) dispatch({ type: "patch", id: existing.id, patch: { pendingUrl: opts.path } });
        dispatch({ type: "focus", id: existing.id });
        return;
      }
      const def = APPS[app];
      const vw = window.innerWidth;
      const vh = window.innerHeight - 56;
      const w = Math.min(def.w, vw - 20);
      const h = Math.min(def.h, vh - 20);
      const n = state.wins.length % 8;
      const x = Math.max(8, Math.min(80 + n * 32, vw - w - 8));
      const y = Math.max(8, Math.min(40 + n * 32, vh - h - 8));
      dispatch({
        type: "open",
        win: {
          app,
          x,
          y,
          w,
          h,
          minimized: false,
          maximized: false,
          folderId: app === "files" ? (opts.folderId ?? null) : undefined,
          fileId: opts.fileId,
          cmd: opts.cmd,
          desktopFile: opts.desktopFile,
          title: opts.name,
          iconUrl: opts.iconUrl,
          external: opts.external,
          path: app === "sysfiles" ? (opts.path ?? "~") : opts.path,
        },
      });
    },
    [state.wins],
  );

  const toggleApp = useCallback(
    (app: AppId) => {
      const mine = state.wins.filter((w) => w.app === app);
      if (mine.length === 0)
        return open(
          app,
          app === "files" ? { folderId: null } : app === "sysfiles" ? { path: "~" } : {},
        );
      const top = mine.reduce((a, b) => (b.z > a.z ? b : a));
      if (top.id === focusedId) dispatch({ type: "minimize", id: top.id });
      else dispatch({ type: "focus", id: top.id });
    },
    [state.wins, focusedId, open],
  );

  const value = useMemo<WmApi>(
    () => ({
      wins: state.wins,
      focusedId,
      isMobile,
      viewport,
      open,
      toggleApp,
      focus: (id) => dispatch({ type: "focus", id }),
      close: (id) => dispatch({ type: "close", id }),
      minimize: (id) => dispatch({ type: "minimize", id }),
      toggleMax: (id) => dispatch({ type: "toggleMax", id }),
      patch: (id, patch) => dispatch({ type: "patch", id, patch }),
      showDesktop: () =>
        dispatch({
          type: state.wins.some((w) => !w.minimized) ? "showDesktop" : "restoreAll",
        }),
      closeFile: (fileId) => dispatch({ type: "closeFile", fileId }),
    }),
    [state.wins, focusedId, isMobile, viewport, open, toggleApp],
  );

  return <Ctx.Provider value={value}>{ready ? children : <div className="fixed inset-0 grid place-items-center bg-slate-950 text-sm text-sky-300">{loadError ? "连接数据库中断，正在重试同步桌面…" : "正在同步桌面屏幕…"}</div>}</Ctx.Provider>;
}
