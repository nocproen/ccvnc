import { denyDesktop } from "@/lib/auth";
import { createGui } from "@/lib/gui";
import fsp from "fs/promises";
import path from "path";
import { HOME } from "@/lib/sys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 读取后台保存的 VNC 密码（~/.webdesktop/vnc-pass，由「后台 → VNC 设置」写入）：
// 有则直接返回给前端用于 noVNC 握手，前端无需再手动输入。
async function storedVncPassword(): Promise<string | null> {
  try {
    const t = await fsp.readFile(path.join(HOME, ".webdesktop", "vnc-pass"), "utf8");
    return t.trim() || null;
  } catch {
    return null;
  }
}

// 启动一个图形应用窗口：立即返回会话号，前端轮询状态直到就绪
export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const b = (await req.json().catch(() => null)) as {
    exec?: unknown;
    desktopFile?: unknown;
    cwd?: unknown;
    name?: unknown;
    w?: unknown;
    h?: unknown;
    preset?: unknown;
    url?: unknown;
    sidHint?: unknown;
    external?: { host?: unknown; port?: unknown };
  } | null;
  if (!b) return Response.json({ error: "请求无效" }, { status: 400 });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const preset = str(b.preset) === "browser" ? "browser" : undefined;
  const external =
    b.external && typeof b.external === "object" && Number.isFinite(Number(b.external.port))
      ? {
          host: typeof b.external.host === "string" ? b.external.host : undefined,
          port: Number(b.external.port),
        }
      : undefined;
  if (!preset && !str(b.exec) && !str(b.desktopFile) && !external) return Response.json({ error: "缺少要运行的命令" }, { status: 400 });
  try {
    const { g, reused } = await createGui({
      preset,
      url: str(b.url),
      sidHint: str(b.sidHint),
      exec: str(b.exec),
      desktopFile: str(b.desktopFile),
      cwd: str(b.cwd),
      name: str(b.name),
      w: Number(b.w),
      h: Number(b.h),
      external,
    });
    const vncPass = external ? await storedVncPassword() : null;
    return Response.json({ sid: g.id, name: g.name, reused, ...(vncPass ? { password: vncPass } : {}) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "启动失败";
    return Response.json({ error: msg }, { status: /过多/.test(msg) ? 429 : 400 });
  }
}
