"use client";

// 后台「概览监控」：CPU / 内存实时曲线 + 系统状态卡片。CPU 使用率由相邻两次采样计算。
import { useEffect, useRef, useState } from "react";

type SysStats = {
  cpu: { user: number; nice: number; system: number; idle: number; iowait: number; irq: number; softirq: number; steal: number; total: number };
  mem: { total: number; available: number; used: number; free: number; buffers: number; cached: number; swapTotal: number; swapFree: number };
  load: number[];
  uptime: number;
  procs: number;
  disk: { total: number; free: number; used: number };
  now: number;
};

type Api = (action: string, body?: object) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> & { error?: string } }>;

const card = "rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-xl";

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}天${h}小时` : h > 0 ? `${h}小时${m}分` : `${m}分钟`;
}

/** 迷你 SVG 折线（60 点滚动窗口） */
function Spark({ data, color, max = 100 }: { data: number[]; color: string; max?: number }) {
  const w = 200;
  const h = 64;
  if (data.length < 2) return <div className="h-16" />;
  const pts = data
    .map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - 3 - Math.min(1, Math.max(0, v / max)) * (h - 6)).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-16 w-full" preserveAspectRatio="none">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      <polyline
        points={`0,${h} ${pts}`}
        fill={color}
        opacity="0.12"
        stroke="none"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default function OverviewPanel({ api, seats }: { api: Api; seats?: { online: number; max: number } }) {
  const [stats, setStats] = useState<SysStats | null>(null);
  const [cpuHist, setCpuHist] = useState<number[]>([]);
  const [memHist, setMemHist] = useState<number[]>([]);
  const prev = useRef<{ cpu?: SysStats["cpu"]; at?: number }>({});

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await api("stats");
      if (!alive || !r.ok) return;
      const s = r.data as unknown as SysStats;
      setStats(s);
      const now = s.now;
      let cpuPct = 0;
      if (prev.current.cpu && prev.current.at && now > prev.current.at) {
        const dc = s.cpu.total - prev.current.cpu.total;
        const di = s.cpu.idle - prev.current.cpu.idle;
        if (dc > 0) cpuPct = Math.max(0, Math.min(100, (1 - di / dc) * 100));
      }
      prev.current = { cpu: s.cpu, at: now };
      setCpuHist((h) => [...h.slice(-59), cpuPct]);
      const memPct = s.mem.total > 0 ? (s.mem.used / s.mem.total) * 100 : 0;
      setMemHist((h) => [...h.slice(-59), memPct]);
    };
    void tick();
    const t = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [api]);

  const s = stats;
  const cpuPct = cpuHist.length ? cpuHist[cpuHist.length - 1] : 0;
  const memPct = s?.mem.total ? (s.mem.used / s.mem.total) * 100 : 0;
  const diskPct = s && s.disk.total > 0 ? (s.disk.used / s.disk.total) * 100 : 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className={card}>
          <div className="text-xs text-slate-400">CPU 使用率</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-sky-300">{cpuPct.toFixed(0)}%</div>
          <div className="mt-1 text-[11px] text-slate-500">{s ? `1/5/15 负载 ${s.load.map((v) => v.toFixed(2)).join(" / ")}` : "—"}</div>
        </div>
        <div className={card}>
          <div className="text-xs text-slate-400">内存</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-emerald-300">{memPct.toFixed(0)}%</div>
          <div className="mt-1 text-[11px] text-slate-500">{s ? `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}` : "—"}</div>
        </div>
        <div className={card}>
          <div className="text-xs text-slate-400">磁盘（/）</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-amber-300">{diskPct.toFixed(0)}%</div>
          <div className="mt-1 text-[11px] text-slate-500">{s ? `${fmtBytes(s.disk.used)} / ${fmtBytes(s.disk.total)}` : "—"}</div>
        </div>
        <div className={card}>
          <div className="text-xs text-slate-400">运行状态</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-white">
            {s ? s.procs : "—"}
            <span className="text-sm font-normal text-slate-500"> 进程</span>
          </div>
          <div className="mt-1 text-[11px] text-slate-500">
            在线席位 {seats ? `${seats.online}/${seats.max}` : "—"} · 已运行 {s ? fmtUptime(s.uptime) : "—"}
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className={card}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">CPU（最近 2 分钟）</span>
            <span className="text-xs tabular-nums text-sky-300">{cpuPct.toFixed(1)}%</span>
          </div>
          <Spark data={cpuHist} color="#38bdf8" />
        </div>
        <div className={card}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">内存（最近 2 分钟）</span>
            <span className="text-xs tabular-nums text-emerald-300">{memPct.toFixed(1)}%</span>
          </div>
          <Spark data={memHist} color="#34d399" />
        </div>
      </div>

      {s && (
        <div className={card}>
          <div className="mb-3 text-sm font-medium">详细信息</div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-slate-400 sm:grid-cols-3">
            <span>内存可用 <span className="text-slate-200">{fmtBytes(s.mem.available)}</span></span>
            <span>内存缓存 <span className="text-slate-200">{fmtBytes(s.mem.cached)}</span></span>
            <span>交换分区 <span className="text-slate-200">{fmtBytes(s.mem.swapTotal - s.mem.swapFree)} / {fmtBytes(s.mem.swapTotal)}</span></span>
            <span>磁盘空闲 <span className="text-slate-200">{fmtBytes(s.disk.free)}</span></span>
            <span>进程总数 <span className="text-slate-200">{s.procs}</span></span>
            <span>运行时长 <span className="text-slate-200">{fmtUptime(s.uptime)}</span></span>
          </div>
        </div>
      )}
    </div>
  );
}
