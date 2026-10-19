// 环境补全：确保 tigervncserver(:1) + XFCE4 图形环境在服务启动时就位。
// 沙箱 / 服务器重启后 VNC 不会自己回来，这里做幂等拉起，后台「VNC 设置」面板依然可用。
const VNC_XSTARTUP = `#!/bin/sh
# TigerVNC 会话启动脚本：拉起 XFCE4 桌面（由 WebDesktop 自动生成）
unset XKL_XMODMAP
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
[ -r "$HOME/.Xresources" ] && xrdb "$HOME/.Xresources"
# 剪贴板管理器：没有它时，在 XFCE 里复制后关掉原应用窗口，剪贴板内容会随之消失
command -v xfce4-clipman >/dev/null 2>&1 && (xfce4-clipman >/dev/null 2>&1 &)
exec startxfce4
`;

async function ensureVnc() {
  const { promises: fsp } = await import("fs");
  const path = await import("path");
  const os = await import("os");
  const { execFile } = await import("child_process");

  const home = os.homedir();
  const vncDir = path.join(home, ".vnc");
  const run = (cmd: string, args: string[], timeout = 10000) =>
    new Promise<{ err: Error | null; out: string }>((resolve) =>
      execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout) =>
        resolve({ err: err as Error | null, out: String(stdout ?? "") }),
      ),
    );

  try {
    await fsp.mkdir(vncDir, { recursive: true });
    const xs = path.join(vncDir, "xstartup");
    // 已有自定义 xstartup 就不覆盖
    const exists = await fsp.access(xs).then(() => true, () => false);
    if (!exists) {
      await fsp.writeFile(xs, VNC_XSTARTUP, { mode: 0o755 });
      await fsp.chmod(xs, 0o755);
    }

    // 密码：环境变量 VNC_PASSWORD 优先；缺失时若 ~/.vnc/passwd 也没有，写一个随机 8 位密码
    const passwd = path.join(vncDir, "passwd");
    const hasPasswd = await fsp.access(passwd).then(() => true, () => false);
    if (!hasPasswd) {
      const pw =
        (process.env.VNC_PASSWORD ?? "").trim().slice(0, 8) ||
        Math.random().toString(36).slice(2, 10);
      const { writeVncPassword } = await import("./lib/vnc-pass");
      const e = await writeVncPassword(pw, passwd);
      if (e) console.warn("[vnc]", e);
      else console.log(`[vnc] 已写入 VNC 密码（${pw.length} 位）到 ~/.vnc/passwd`);
      try {
        await fsp.mkdir(path.join(home, ".webdesktop"), { recursive: true });
        await fsp.writeFile(path.join(home, ".webdesktop", "vnc-pass"), pw, { mode: 0o600 });
      } catch {
        /* ignore */
      }
    }

    const listed = await run("tigervncserver", ["-list"]);
    const running = /^\s*1\s/m.test(listed.out) && /5901/.test(listed.out);
    if (running) {
      console.log("[vnc] tigervncserver :1 已在运行（端口 5901）");
      return;
    }

    const started = await run("tigervncserver", [
      ":1",
      "-localhost",
      "yes",
      "-geometry",
      "1600x900",
      "-depth",
      "24",
      "-AlwaysShared",
      "-SecurityTypes",
      "VncAuth",
    ]);
    if (started.err) console.warn("[vnc] 启动失败：", started.err.message);
    else console.log("[vnc] 已启动 tigervncserver :1（1600x900，端口 5901，AlwaysShared）");
  } catch (e) {
    console.warn("[vnc] 图形环境初始化失败：", e instanceof Error ? e.message : e);
  }
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { installBrowserWs } = await import("./lib/browser-ws");
  installBrowserWs();

  // 首次部署：用环境变量初始化认证表与桌面访问密码（已设置过则不覆盖）
  try {
    const { ensureAuthTables, isDesktopPasswordSet, setDesktopPassword } = await import("./lib/auth");
    await ensureAuthTables();
    if (process.env.DESKTOP_PASSWORD && !(await isDesktopPasswordSet())) {
      await setDesktopPassword(process.env.DESKTOP_PASSWORD, null);
      console.log("[deploy] 已初始化桌面访问密码");
    }
  } catch (e) {
    console.error("[deploy] 初始化桌面密码失败", e);
  }

  // 环境补全：xfce4 + tigervncserver（后台异步，不阻塞启动）
  void ensureVnc();

  // 自动更新已移除：不再启动 deploy watcher
}
