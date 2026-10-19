import {
  DESKTOP_COOKIE,
  DESKTOP_SHORT_AGE,
  clearCookieHeader,
  cookieValue,
  denyDesktop,
  dropDesktopCookieToken,
  requestDesktopSession,
  revokeDesktopSession,
  setCookieHeader,
} from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;

  const sid = requestDesktopSession(req);
  // 多人在线模式：只注销当前这一个会话，立即释放一个席位，其他人继续在线。
  await revokeDesktopSession(sid).catch(() => {});

  const rest = await dropDesktopCookieToken(cookieValue(req.headers.get("cookie"), DESKTOP_COOKIE), sid).catch(() => "");
  const cookie = rest
    ? setCookieHeader(DESKTOP_COOKIE, rest, req, DESKTOP_SHORT_AGE)
    : clearCookieHeader(DESKTOP_COOKIE, req);

  return Response.json({ ok: true }, { headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" } });
}
