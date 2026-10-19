import { DESKTOP_MAX_SESSIONS, denyDesktop, listDesktopSessions, requestDesktopSession, touchDesktopSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;
  // 这个请求本身就是心跳：刷新本网页的在线状态，并回收已经关掉/崩溃的老会话。
  // 没有它，关掉标签页只会在服务端留下"幽灵会话"，白占席位，攒够上限就把真正在用的网页挤下线。
  await touchDesktopSession(requestDesktopSession(req)).catch(() => {});
  // 顺带回传在线席位信息，前端可显示「当前 2/3 人在线」。
  const online = await listDesktopSessions()
    .then((list) => list.length)
    .catch(() => 0);
  return Response.json({ ok: true, online, max: DESKTOP_MAX_SESSIONS }, { headers: { "Cache-Control": "no-store" } });
}
