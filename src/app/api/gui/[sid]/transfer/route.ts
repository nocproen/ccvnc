import { denyDesktop } from "@/lib/auth";
import { getGui, readClipOfDisplay } from "@/lib/gui";
import { DESKTOP, HOME, resolveP } from "@/lib/sys";
import fsp from "fs/promises";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sid: string }> };

const MAX_UPLOAD = 512 * 1024 * 1024;

type Entry = { name: string; path: string; dir: boolean; size: number; mtime: number };

async function describe(p: string): Promise<Entry | null> {
  try {
    const st = await fsp.stat(p);
    return { name: path.basename(p), path: p, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

/** 选一个不重名的目标文件名：a.txt → a (1).txt */
async function uniqueTarget(dir: string, name: string) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let target = path.join(dir, name);
  for (let i = 1; i < 1000; i++) {
    try {
      await fsp.access(target);
      target = path.join(dir, `${base} (${i})${ext}`);
    } catch {
      return target;
    }
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/**
 * VNC 文件互传：
 *  GET ?action=clip            读取远程桌面剪贴板（文件管理器里 Ctrl+C 复制的文件 / 图片 / 文本）
 *  GET ?action=list&dir=...    列出目录（默认远程桌面 ~/Desktop）
 */
export async function GET(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const g = getGui(sid);
  if (!g) return Response.json({ error: "会话不存在或已结束" }, { status: 404 });
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "list";

  if (action === "clip") {
    const clip = await readClipOfDisplay(g.display).catch(() => null);
    if (!clip) return Response.json({ kind: "empty", files: [], text: "" });
    const files = (await Promise.all(clip.paths.map(describe))).filter((x): x is Entry => !!x);
    return Response.json({ kind: clip.kind, files, text: clip.text.slice(0, 200_000) });
  }

  const dir = resolveP(url.searchParams.get("dir") || DESKTOP);
  try {
    await fsp.mkdir(DESKTOP, { recursive: true }).catch(() => {});
    const names = await fsp.readdir(dir);
    const entries = (
      await Promise.all(names.filter((n) => !n.startsWith(".")).map((n) => describe(path.join(dir, n))))
    ).filter((x): x is Entry => !!x);
    entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, "zh") : a.dir ? -1 : 1));
    return Response.json({ dir, parent: dir === "/" ? null : path.dirname(dir), home: HOME, desktop: DESKTOP, entries });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "无法读取目录" }, { status: 400 });
  }
}

/** POST 原始文件内容（?name=文件名&dir=目标目录，默认远程桌面 ~/Desktop）：上传后直接出现在远程桌面上 */
export async function POST(req: Request, ctx: Ctx) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  const { sid } = await ctx.params;
  const g = getGui(sid);
  if (!g) return Response.json({ error: "会话不存在或已结束" }, { status: 404 });
  const url = new URL(req.url);
  const rawName = (url.searchParams.get("name") ?? "").replace(/[/\\\0]/g, "_").trim() || `文件-${Date.now()}`;
  const dir = resolveP(url.searchParams.get("dir") || DESKTOP);
  const data = Buffer.from(await req.arrayBuffer());
  if (data.length > MAX_UPLOAD) return Response.json({ error: "单个文件不能超过 512MB" }, { status: 400 });
  try {
    await fsp.mkdir(dir, { recursive: true });
    const target = await uniqueTarget(dir, rawName);
    await fsp.writeFile(target, data);
    return Response.json({ ok: true, path: target, name: path.basename(target), size: data.length });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "上传失败" }, { status: 400 });
  }
}
