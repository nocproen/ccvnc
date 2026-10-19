import { execFile } from "child_process";
import fsp from "fs/promises";
import os from "os";
import path from "path";

// 300ms+ 延迟下，1600x900 / 随浏览器放大分辨率会让首屏更新要传好几秒。
// 看门狗会把「还在传」误判成卡死并强制重连，重连又把画布清空 —— 表现就是黑屏后反复重连。
// 这里把远端帧缓冲锁死在一个小尺寸，帧率压到 8fps，并禁止客户端改分辨率。
export const VNC_DISPLAY = ":1";
export const VNC_PORT = 5901;
export const VNC_DEPTH = "24";

const MAX_W = 1280;
const MAX_H = 720;
const DEFAULT_W = 1024;
const DEFAULT_H = 576;

const holder = globalThis as unknown as {
  __wdVncKeeper?: boolean;
  __wdVncGeoRestart?: number;
};

export const VNC_XSTARTUP_REV = "3";

export const VNC_XSTARTUP = `#!/bin/sh
# TigerVNC 会话启动脚本：拉起 XFCE4 桌面（由 WebDesktop 自动生成）
# WD_XSTARTUP_REV=${VNC_XSTARTUP_REV}
unset XKL_XMODMAP
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
export XKL_XMODMAP_DISABLE=1
# 合成器会让 VNC 每次都重发整屏，高延迟时直接黑屏/闪烁
export XFWM4_COMPOSITOR=off
[ -r "$HOME/.Xresources" ] && xrdb "$HOME/.Xresources"
xset s off 2>/dev/null || true
xset -dpms 2>/dev/null || true
xset s noblank 2>/dev/null || true
mkdir -p "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml" "$HOME/.config/autostart"
cat > "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="use_compositing" type="bool" value="false"/>
    <property name="sync_to_vblank" type="bool" value="false"/>
    <property name="show_frame_shadow" type="bool" value="false"/>
    <property name="show_popup_shadow" type="bool" value="false"/>
    <property name="show_dock_shadow" type="bool" value="false"/>
  </property>
</channel>
EOF
cat > "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-screensaver.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-screensaver" version="1.0">
  <property name="saver" type="empty">
    <property name="enabled" type="bool" value="false"/>
    <property name="mode" type="int" value="0"/>
  </property>
  <property name="lock" type="empty">
    <property name="enabled" type="bool" value="false"/>
    <property name="saver-activation" type="empty">
      <property name="enabled" type="bool" value="false"/>
    </property>
  </property>
</channel>
EOF
cat > "$HOME/.config/autostart/wd-vnc-tune.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=WebDesktop VNC tune
Hidden=false
X-GNOME-Autostart-enabled=true
Exec=sh -c "xset s off; xset -dpms; xset s noblank; xfconf-query -c xfwm4 -p /general/use_compositing -s false; xfconf-query -c xfce4-screensaver -p /saver/enabled -s false; xfconf-query -c xfce4-screensaver -p /lock/enabled -s false; pkill -f xfce4-screensaver || true; pkill -f light-locker || true"
EOF
(
  sleep 5
  xset s off; xset -dpms; xset s noblank
  xfconf-query -c xfwm4 -p /general/use_compositing -s false 2>/dev/null || true
  xfconf-query -c xfce4-screensaver -p /saver/enabled -s false 2>/dev/null || true
  xfconf-query -c xfce4-screensaver -p /lock/enabled -s false 2>/dev/null || true
  pkill -f xfce4-screensaver 2>/dev/null || true
  pkill -f light-locker 2>/dev/null || true
) >/dev/null 2>&1 &
command -v xfce4-clipman >/dev/null 2>&1 && (xfce4-clipman >/dev/null 2>&1 &)
exec startxfce4
`;

function run(cmd: string, args: string[], timeout = 20_000, env?: NodeJS.ProcessEnv) {
  return new Promise<{ err: Error | null; out: string }>((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024, env }, (err, stdout, stderr) => {
      resolve({ err: err as Error | null, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

export function vncGeometry(raw?: string | null) {
  const src = (raw ?? process.env.VNC_GEOMETRY ?? "").trim();
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(src);
  let w = m ? Number(m[1]) : DEFAULT_W;
  let h = m ? Number(m[2]) : DEFAULT_H;
  w = Math.min(MAX_W, Math.max(640, Math.round(w / 8) * 8));
  h = Math.min(MAX_H, Math.max(360, Math.round(h / 8) * 8));
  return `${w}x${h}`;
}

export function vncFrameRate() {
  const n = Number(process.env.VNC_FRAME_RATE ?? 8);
  if (!Number.isFinite(n)) return "8";
  return String(Math.min(12, Math.max(4, Math.round(n))));
}

export function vncServerArgs(display = VNC_DISPLAY, geometry = vncGeometry()) {
  const home = os.homedir();
  return [
    display,
    "-localhost",
    "yes",
    "-xstartup",
    path.join(home, ".vnc", "xstartup"),
    "-geometry",
    geometry,
    "-depth",
    VNC_DEPTH,
    "-AlwaysShared",
    "-DisconnectClients",
    "0",
    "-SecurityTypes",
    "VncAuth",
    "-FrameRate",
    vncFrameRate(),
    "-CompareFB",
    "1",
    "-IdleTimeout",
    "0",
    "-MaxIdleTime",
    "0",
    "-MaxDisconnectionTime",
    "0",
    // 禁止网页把远端分辨率改成浏览器视口（往往是 1920+），这是黑屏重连的主要来源
    "-AcceptSetDesktopSize",
    "0",
    "-desktop",
    "WebDesktop",
  ];
}

async function writeConfig(home: string, geometry: string) {
  const vncDir = path.join(home, ".vnc");
  await fsp.mkdir(vncDir, { recursive: true, mode: 0o700 });
  const xs = path.join(vncDir, "xstartup");
  let current = "";
  try {
    current = await fsp.readFile(xs, "utf8");
  } catch {
    current = "";
  }
  if (!current.includes(`WD_XSTARTUP_REV=${VNC_XSTARTUP_REV}`)) {
    await fsp.writeFile(xs, VNC_XSTARTUP, { mode: 0o755 });
    await fsp.chmod(xs, 0o755);
  }
  const conf = [
    `geometry=${geometry}`,
    `depth=${VNC_DEPTH}`,
    "localhost=yes",
    "alwaysshared=1",
    "disconnectclients=0",
    "securitytypes=VncAuth",
    `framerate=${vncFrameRate()}`,
    "comparefb=1",
    "idletimeout=0",
    "maxidletime=0",
    "maxdisconnectiontime=0",
    "acceptsetdesktopsize=0",
    "desktop=WebDesktop",
    "",
  ].join("\n");
  await fsp.writeFile(path.join(vncDir, "config"), conf, { mode: 0o644 });
}

async function ensurePassword(home: string) {
  const vncDir = path.join(home, ".vnc");
  const passwd = path.join(vncDir, "passwd");
  const plainFile = path.join(home, ".webdesktop", "vnc-pass");
  const fromEnv = (process.env.VNC_PASSWORD ?? "").trim().slice(0, 8);
  let plain = "";
  try {
    plain = (await fsp.readFile(plainFile, "utf8")).trim().slice(0, 8);
  } catch {
    plain = "";
  }
  const hasPasswd = await fsp.access(passwd).then(() => true, () => false);
  const pw = fromEnv || plain || Math.random().toString(36).slice(2, 10).slice(0, 8);
  if (hasPasswd && plain === pw && (!fromEnv || fromEnv === plain)) return pw;
  const { writeVncPassword } = await import("./vnc-pass");
  const err = await writeVncPassword(pw, passwd);
  if (err) throw new Error(err);
  await fsp.mkdir(path.join(home, ".webdesktop"), { recursive: true, mode: 0o700 });
  await fsp.writeFile(plainFile, pw, { mode: 0o600 });
  console.log(`[vnc] 已写入 VNC 密码（${pw.length} 位）`);
  return pw;
}

async function listDisplay(display: string) {
  const listed = await run("tigervncserver", ["-list"]);
  const num = display.replace(":", "");
  const running = new RegExp(`^\\s*${num}\\s`, "m").test(listed.out) && listed.out.includes(String(5900 + Number(num)));
  return { running, out: listed.out, err: listed.err };
}

async function readGeometry(home: string, display: string) {
  const env = {
    ...process.env,
    DISPLAY: display,
    XAUTHORITY: path.join(home, ".Xauthority"),
  };
  const info = await run("xdpyinfo", [], 5000, env);
  const m = /dimensions:\s+(\d+)x(\d+)/.exec(info.out);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]) };
}

async function tuneSession(home: string, display: string) {
  const env = {
    ...process.env,
    DISPLAY: display,
    XAUTHORITY: path.join(home, ".Xauthority"),
  };
  await run("xset", ["s", "off"], 4000, env);
  await run("xset", ["-dpms"], 4000, env);
  await run("xset", ["s", "noblank"], 4000, env);
  await run("xfconf-query", ["-c", "xfwm4", "-p", "/general/use_compositing", "-s", "false"], 4000, env);
  await run("xfconf-query", ["-c", "xfce4-screensaver", "-p", "/saver/enabled", "-s", "false"], 4000, env);
  await run("xfconf-query", ["-c", "xfce4-screensaver", "-p", "/lock/enabled", "-s", "false"], 4000, env);
}

async function startServer(display: string, geometry: string) {
  const started = await run("tigervncserver", vncServerArgs(display, geometry), 25_000);
  if (started.err) {
    console.warn("[vnc] 启动失败：", started.err.message, started.out.slice(-400));
    return false;
  }
  console.log(`[vnc] 已启动 tigervncserver ${display}（${geometry}，${vncFrameRate()}fps，禁止改分辨率）`);
  return true;
}

function profileRev(geometry: string) {
  return `${VNC_XSTARTUP_REV}:${geometry}:${vncFrameRate()}:xstartup`;
}

let inflight: Promise<void> | null = null;

export function ensureVncDesktop() {
  inflight ??= (async () => {
    const home = os.homedir();
    const geometry = vncGeometry();
    const revFile = path.join(home, ".vnc", "profile-rev");
    await writeConfig(home, geometry);
    await ensurePassword(home);
    const want = profileRev(geometry);
    let have = "";
    try {
      have = (await fsp.readFile(revFile, "utf8")).trim();
    } catch {
      have = "";
    }
    const listed = await listDisplay(VNC_DISPLAY);
    const geo = listed.running ? await readGeometry(home, VNC_DISPLAY) : null;
    const [maxW, maxH] = geometry.split("x").map(Number);
    const tooBig = !!geo && (geo.w > maxW + 8 || geo.h > maxH + 8);
    const stale = listed.running && (have !== want || tooBig);
    const recently = Date.now() - (holder.__wdVncGeoRestart ?? 0) < 60_000;
    if (listed.running && stale && !recently) {
      holder.__wdVncGeoRestart = Date.now();
      console.warn(`[vnc] 会话配置过期（${geo ? `${geo.w}x${geo.h}` : "unknown"}），按 ${geometry} 重启`);
      await run("tigervncserver", ["-kill", VNC_DISPLAY], 12_000);
      await new Promise((r) => setTimeout(r, 800));
    } else if (listed.running) {
      await tuneSession(home, VNC_DISPLAY);
      return;
    }
    const ok = await startServer(VNC_DISPLAY, geometry);
    if (ok) await fsp.writeFile(revFile, want, { mode: 0o644 });
  })()
    .catch((e) => {
      console.warn("[vnc] 图形环境初始化失败：", e instanceof Error ? e.message : e);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 后台「重启 VNC」：按高延迟配置重新拉起，并忽略过大的自定义分辨率。 */
export async function restartVncDesktop(display = VNC_DISPLAY, geometry?: string) {
  const home = os.homedir();
  const geo = vncGeometry(geometry);
  await writeConfig(home, geo);
  await ensurePassword(home);
  await run("tigervncserver", ["-kill", display], 12_000);
  await new Promise((r) => setTimeout(r, 800));
  const ok = await startServer(display, geo);
  if (ok) {
    await new Promise((r) => setTimeout(r, 1200));
    await tuneSession(home, display).catch(() => {});
  }
  return { ok, geometry: geo, display };
}

export function keepVncAlive() {
  if (holder.__wdVncKeeper) return;
  holder.__wdVncKeeper = true;
  const t = setInterval(() => {
    void ensureVncDesktop();
  }, 30_000);
  t.unref?.();
  void ensureVncDesktop();
}
