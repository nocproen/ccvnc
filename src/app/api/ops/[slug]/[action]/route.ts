import {
  ADMIN_COOKIE,
  ADMIN_MAX_AGE,
  ADMIN_SLUG,
  bumpDesktopVersion,
  clearCookieHeader,
  clearDesktopPassword,
  clientIp,
  createAdminToken,
  findAdminByName,
  getDesktopPlain,
  getDesktopSeats,
  getDesktopStatus,
  lockedFor,
  recordFailure,
  recordSuccess,
  remainingAttempts,
  requireAdmin,
  setCookieHeader,
  setDesktopExpiry,
  setDesktopPassword,
  updateAdmin,
  verifyPassword,
} from "@/lib/auth";
import { execFile } from "child_process";
import fsp from "fs/promises";
import { HOME, ensureHome } from "@/lib/sys";
import { systemStats, vncStatus } from "@/lib/sys-stats";
import { writeVncPassword } from "@/lib/vnc-pass";

// 后台接口。路径中必须带正确的后台路径(slug)，否则一律返回 404，不暴露后台存在。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; action: string }> };

const json = (body: object, status = 200, headers?: Record<string, string>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// 有效期：分钟数（从现在起算）；null / 0 / 未提供 = 永久有效
function parseExpiry(v: unknown): number | null | "bad" {
  if (v === null || v === undefined || v === 0 || v === "forever") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 3650 * 24 * 60) return "bad";
  return Date.now() + n * 60_000;
}
const USER_RE = /^[A-Za-z0-9_.-]{3,32}$/;

async function handle(req: Request, ctx: Ctx, method: "GET" | "POST") {
  const { slug, action } = await ctx.params;
  if (slug !== ADMIN_SLUG) return json({ error: "Not found" }, 404);

  const body = method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");

  if (action === "login" && method === "POST") {
    const ip = clientIp(req);
    const wait = lockedFor("admin", ip);
    if (wait > 0) return json({ error: `尝试次数过多，请 ${Math.ceil(wait / 60)} 分钟后再试` }, 429);
    const username = str("username").trim();
    const password = str("password");
    if (!username || !password || username.length > 64 || password.length > 256) {
      return json({ error: "请输入账号和密码" }, 400);
    }
    const user = await findAdminByName(username);
    const ok = await verifyPassword(password, user?.passwordHash);
    if (!user || !ok) {
      recordFailure("admin", ip);
      await sleep(600);
      const left = remainingAttempts("admin", ip);
      return json({ error: left > 0 ? `账号或密码不正确（还可尝试 ${left} 次）` : "尝试次数过多，已被临时锁定 10 分钟" }, 401);
    }
    recordSuccess("admin", ip);
    const session = await createAdminToken(user);
    return json({ ok: true, mustChange: user.mustChange, sessionId: session.sessionId }, 200, {
      "Set-Cookie": setCookieHeader(ADMIN_COOKIE, session.token, req, ADMIN_MAX_AGE),
    });
  }

  if (action === "logout" && method === "POST") {
    if (!(await requireAdmin(req))) return json({ error: "会话已经失效" }, 401);
    return json({ ok: true }, 200, { "Set-Cookie": clearCookieHeader(ADMIN_COOKIE, req) });
  }

  // 以下接口都需要管理员登录
  const admin = await requireAdmin(req);
  if (!admin) return json({ error: "未登录或登录已过期" }, 401);

  if (action === "state" && method === "GET") {
    const desktop = await getDesktopStatus();
    const seatInfo = await getDesktopSeats().catch(() => ({ online: 0, max: 0, sessions: [] }));
    return json({
      username: admin.username,
      mustChange: admin.mustChange,
      desktop,
      seats: { online: seatInfo.online, max: seatInfo.max },
      // 当前桌面密码明文：仅在管理员已改掉默认密码后返回
      desktopPassword: !admin.mustChange && desktop.set ? await getDesktopPlain() : null,
      serverNow: Date.now(),
    });
  }

  if (action === "account" && method === "POST") {
    const current = str("currentPassword");
    if (!(await verifyPassword(current, admin.passwordHash))) {
      await sleep(600);
      return json({ error: "当前密码不正确" }, 403);
    }
    const newUser = str("username").trim();
    const newPass = str("newPassword");
    const patch: { username?: string; password?: string } = {};
    if (newUser && newUser !== admin.username) {
      if (!USER_RE.test(newUser)) return json({ error: "账号需为 3–32 位字母、数字、下划线、点或短横线" }, 400);
      const exists = await findAdminByName(newUser);
      if (exists) return json({ error: "该账号名已被使用" }, 409);
      patch.username = newUser;
    }
    if (newPass) {
      if (newPass.length < 8 || newPass.length > 128) return json({ error: "新密码长度需为 8–128 位" }, 400);
      if (newPass === current) return json({ error: "新密码不能与当前密码相同" }, 400);
      patch.password = newPass;
    }
    if (admin.mustChange && !patch.password) return json({ error: "首次登录必须修改密码" }, 400);
    if (!patch.username && !patch.password) return json({ error: "没有需要修改的内容" }, 400);
    const updated = await updateAdmin(admin.id, patch);
    // 密码变了，旧令牌作废；给当前浏览器签发新令牌
    const session = await createAdminToken(updated);
    return json({ ok: true, username: updated.username, sessionId: session.sessionId }, 200, {
      "Set-Cookie": setCookieHeader(ADMIN_COOKIE, session.token, req, ADMIN_MAX_AGE),
    });
  }

  if (admin.mustChange) return json({ error: "请先修改默认的后台密码" }, 403);

  if (action === "desktop-password" && method === "POST") {
    if (body.clear === true) {
      await clearDesktopPassword();
      return json({ ok: true });
    }
    const pw = str("password");
    if (pw.length < 6 || pw.length > 128) return json({ error: "桌面密码长度需为 6–128 位" }, 400);
    const exp = parseExpiry(body.expiresInMinutes);
    if (exp === "bad") return json({ error: "有效期无效（1 分钟 ~ 10 年，或选择永久）" }, 400);
    await setDesktopPassword(pw, exp); // 同时让所有已登录的桌面下线
    return json({ ok: true });
  }

  if (action === "desktop-expiry" && method === "POST") {
    if (!(await getDesktopStatus()).set) return json({ error: "还没有设置桌面密码" }, 400);
    const exp = parseExpiry(body.expiresInMinutes);
    if (exp === "bad") return json({ error: "有效期无效（1 分钟 ~ 10 年，或选择永久）" }, 400);
    await setDesktopExpiry(exp);
    return json({ ok: true });
  }

  if (action === "kick" && method === "POST") {
    await bumpDesktopVersion();
    return json({ ok: true });
  }

  // 系统监控（CPU / 内存 / 负载 / 磁盘）
  if (action === "stats" && method === "GET") {
    return json(await systemStats());
  }

  // VNC 状态（tigervncserver 是否运行、端口、密码文件）
  if (action === "vncstatus" && method === "GET") {
    return json(await vncStatus(HOME));
  }

  // 设置 VNC 密码：写入 ~/.vnc/passwd（tigervncserver 认证用）+ ~/.webdesktop/vnc-pass（前端直连用，免手动输入）
  if (action === "vncpass" && method === "POST") {
    const pw = str("password");
    if (!/^[\x21-\x7e]{1,8}$/.test(pw)) return json({ error: "VNC 密码需为 1–8 位可见 ASCII 字符（tigervncserver 只支持前 8 字节）" }, 400);
    await ensureHome();
    const dir = `${HOME}/.vnc`;
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const err = await writeVncPassword(pw, `${dir}/passwd`);
    if (err) return json({ error: err }, 500);
    // 前端免输入用：明文保存在服务器（0600），登录外部桌面时由后端直接下发
    await fsp.mkdir(`${HOME}/.webdesktop`, { recursive: true, mode: 0o700 });
    await fsp.writeFile(`${HOME}/.webdesktop/vnc-pass`, pw, { mode: 0o600 });
    return json({ ok: true, note: "VNC 密码已保存：重启 tigervncserver 后生效，网页端将直接连接无需再输入" });
  }

  // 重启 tigervncserver（-AlwaysShared 允许网页与本地 VNC 客户端同时连接）
  if (action === "vncrestart" && method === "POST") {
    const home = HOME;
    const before = await vncStatus(home);
    const display = typeof body.display === "string" && /^:\d+$/.test(body.display) ? (body.display as string) : before.display ?? ":1";
    const geometry = typeof body.geometry === "string" && /^\d+x\d+$/.test(body.geometry) ? (body.geometry as string) : "1600x900";
    try {
      if (before.running && before.display) {
        await new Promise<void>((resolve) => {
          execFile("tigervncserver", ["-kill", before.display!], { timeout: 8000 }, () => resolve());
        });
      }
      await new Promise<void>((resolve, reject) => {
        execFile(
          "tigervncserver",
          [display, "-geometry", geometry, "-AlwaysShared"],
          { timeout: 15_000 },
          (err, _stdout, stderr) => (err ? reject(new Error(stderr || String(err))) : resolve()),
        );
      });
      await sleep(1200);
      const after = await vncStatus(home);
      return json({ ok: true, vnc: after, note: after.running ? `${after.display} 已运行（端口 ${after.port}，几何 ${geometry}）` : "VNC 启动失败，请查看服务日志" });
    } catch (e) {
      return json({ error: `重启 VNC 失败：${e instanceof Error ? e.message : String(e)}` }, 500);
    }
  }

  return json({ error: "Not found" }, 404);
}

export const GET = (req: Request, ctx: Ctx) => handle(req, ctx, "GET");
export const POST = (req: Request, ctx: Ctx) => handle(req, ctx, "POST");
