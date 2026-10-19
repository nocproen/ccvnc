import { eq } from "drizzle-orm";
import { db } from "@/db";
import { desktopWorkspace } from "@/db/schema";
import { denyDesktop } from "@/lib/auth";
import { subscribeLive } from "@/lib/live-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 桌面实时同步通道（Server-Sent Events）。
// 浏览器端用 EventSource 订阅：连上先收到一份当前快照（hello），之后任何网页改了桌面都会广播。
// 用 SSE 而不是轮询：拖窗口时几十毫秒一次的改动能立刻出现在其他网页上，且不会产生大量空请求。
const HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  // 让 nginx 等反向代理不要缓冲事件流
  "X-Accel-Buffering": "no",
};

export async function GET(req: Request) {
  const denied = await denyDesktop(req);
  if (denied) return denied;

  const encoder = new TextEncoder();
  let closed = false;
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };
      const send = (msg: unknown) => write(`data: ${JSON.stringify(msg)}\n\n`);

      // 连接建立 / 断线重连后先给一份当前版本，网页据此补齐错过的改动
      try {
        const [row] = await db.select().from(desktopWorkspace).where(eq(desktopWorkspace.id, 1));
        send({
          type: "workspace",
          version: row?.version ?? 0,
          snapshot: row?.snapshot ?? { wins: [], z: 10, seq: 0 },
          hello: true,
        });
      } catch {
        // 数据库暂时不可用：不主动断开，后续改动仍会推送
        write(": db-unavailable\n\n");
      }

      const unsubscribe = subscribeLive((msg) => send(msg));
      // 心跳：穿过代理 / 负载均衡时避免连接被判定为空闲而切断
      const beat = setInterval(() => write(": ping\n\n"), 20_000);

      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // 已经关闭
        }
      };

      // 网页关闭 / 刷新 / 网络断开：Request 的 abort 会触发
      req.signal.addEventListener("abort", stop, { once: true });
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, { headers: HEADERS });
}
