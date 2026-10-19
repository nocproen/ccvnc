import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    // 健康检查也会兜底拉起认证表和图形环境，避免 instrumentation 没跑时桌面不可用。
    void import("@/lib/boot")
      .then((m) => m.bootApp())
      .catch(() => {});
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
