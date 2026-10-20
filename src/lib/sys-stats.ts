import { execFile } from "child_process";
import fsp from "fs/promises";
import fs from "fs";

// 系统监控：CPU / 内存 / 负载 / 磁盘 / 进程数 / 运行时长，以及 tigervncserver 运行状态。
// CPU 返回累计计数器，前端用相邻两次采样计算使用率（跨进程不丢历史）。

export type SystemStats = {
  cpu: {
    user: number;
    nice: number;
    system: number;
    idle: number;
    iowait: number;
    irq: number;
    softirq: number;
    steal: number;
    total: number;
  };
  mem: {
    total: number;
    available: number;
    used: number;
    free: number;
    buffers: number;
    cached: number;
    swapTotal: number;
    swapFree: number;
  };
  load: number[]; // 1/5/15 分钟负载
  uptime: number; // 秒
  procs: number; // 进程数
  disk: { total: number; free: number; used: number };
  now: number;
};

export type VncInfo = {
  running: boolean;
  display: string | null;
  port: number | null;
  geometry: string | null;
  passwdSet: boolean;
  server: string | null;
};

async function readProc(p: string): Promise<string> {
  try {
    return await fsp.readFile(p, "utf8");
  } catch {
    return "";
  }
}

export async function systemStats(): Promise<SystemStats> {
  let cpu: SystemStats["cpu"] = { user: 0, nice: 0, system: 0, idle: 0, iowait: 0, irq: 0, softirq: 0, steal: 0, total: 0 };
  const stat = await readProc("/proc/stat");
  const line = stat.split("\n").find((l) => l.startsWith("cpu "));
  if (line) {
    const p = line.split(/\s+/).slice(1).map(Number);
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = p;
    cpu = { user, nice, system, idle, iowait, irq, softirq, steal, total: user + nice + system + idle + iowait + irq + softirq + steal };
  }

  const memRaw: Record<string, number> = {};
  for (const l of (await readProc("/proc/meminfo")).split("\n")) {
    const m = /^(\w+):\s+(\d+)\s+kB/.exec(l);
    if (m) memRaw[m[1]] = Number(m[2]) * 1024;
  }
  const total = memRaw.MemTotal ?? 0;
  const available = memRaw.MemAvailable ?? memRaw.MemFree ?? 0;
  const mem = {
    total,
    available,
    used: total - available,
    free: memRaw.MemFree ?? 0,
    buffers: memRaw.Buffers ?? 0,
    cached: (memRaw.Cached ?? 0) + (memRaw.SReclaimable ?? 0),
    swapTotal: memRaw.SwapTotal ?? 0,
    swapFree: memRaw.SwapFree ?? 0,
  };

  const load = (await readProc("/proc/loadavg")).split(/\s+/).slice(0, 3).map(Number);
  const uptime = Number((await readProc("/proc/uptime")).split(/\s+/)[0] ?? 0);
  let procs = 0;
  try {
    procs = (await fsp.readdir("/proc")).filter((x) => /^\d+$/.test(x)).length;
  } catch {
    /* ignore */
  }

  let disk = { total: 0, free: 0, used: 0 };
  try {
    const s = fs.statfsSync("/");
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
  } catch {
    /* ignore */
  }

  return { cpu, mem, load, uptime, procs, disk, now: Date.now() };
}

/** 通过 tigervncserver -list 解析当前运行的 VNC 会话 */
export async function vncStatus(home: string): Promise<VncInfo> {
  const info: VncInfo = { running: false, display: null, port: null, geometry: null, passwdSet: false, server: null };
  try {
    const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
      execFile("tigervncserver", ["-list"], { timeout: 8000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve({ stdout });
      });
    });
    // 表头后每行：5<TAB>5905<TAB>/tmp/.X11-unix/X5<TAB>PID<TAB>Xtigervnc（DISPLAY 列是数字，不带冒号）
    for (const l of stdout.split("\n")) {
      const m = /^\s*:?(\d+)\s+(\d+)/.exec(l);
      if (m) {
        info.running = true;
        info.display = `:${m[1]}`;
        info.port = Number(m[2]);
      }
    }
    info.server = "tigervncserver";
  } catch {
    // 命令不可用：回退到进程检测
    try {
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        execFile("ps", ["-eo", "args"], { timeout: 8000 }, (err, stdout) => {
          if (err) return reject(err);
          resolve({ stdout });
        });
      });
      const m = /(?:^|\s)(Xvnc|tigervncserver)[^\n]*?(?:\s|^)(:\d+)(?:\s|$)/.exec(stdout);
      if (m) {
        info.running = true;
        info.display = m[2];
        info.port = 5900 + Number(m[2].slice(1));
        info.server = m[1];
      }
    } catch {
      /* ignore */
    }
  }
  if (info.running && info.display) {
    try {
      const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
        execFile("xdpyinfo", ["-display", info.display!], {
          timeout: 5000,
          env: { ...process.env, XAUTHORITY: `${home}/.Xauthority` },
        }, (err, stdout) => {
          if (err) return reject(err);
          resolve({ stdout });
        });
      });
      info.geometry = /dimensions:\s+(\d+x\d+)/.exec(stdout)?.[1] ?? null;
    } catch {
      // 状态接口在 X11 暂不可用时仍能返回 VNC 服务信息。
    }
  }
  try {
    const st = await fsp.stat(`${home}/.vnc/passwd`);
    info.passwdSet = st.size >= 8;
  } catch {
    info.passwdSet = false;
  }
  return info;
}
