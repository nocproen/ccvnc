"use client";

// 后台「VNC 设置」：查看 tigervncserver 运行状态、设置 VNC 密码（写入 ~/.vnc/passwd）、一键重启。
import { useEffect, useState } from "react";

type VncInfo = { running: boolean; display: string | null; port: number | null; passwdSet: boolean; server: string | null };
type Api = (action: string, body?: object) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> & { error?: string } }>;

const card = "rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-xl";
const input =
  "w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none placeholder:text-slate-500 focus:border-sky-400";

export default function VncPanel({ api }: { api: Api }) {
  const [info, setInfo] = useState<VncInfo | null>(null);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api("vncstatus");
    if (r.ok) setInfo(r.data as unknown as VncInfo);
  };
  useEffect(() => {
    void load();
  }, [api]);

  const save = async () => {
    if (!/^[\x21-\x7e]{1,8}$/.test(pw)) return setMsg({ ok: false, text: "VNC 密码需为 1–8 位可见 ASCII 字符（tigervncserver 只认前 8 字节）" });
    if (pw !== pw2) return setMsg({ ok: false, text: "两次输入的密码不一致" });
    setBusy(true);
    const r = await api("vncpass", { password: pw });
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? (r.data.note as string) ?? "已保存" : (r.data.error as string) ?? "保存失败" });
    if (r.ok) {
      setPw("");
      setPw2("");
      void load();
    }
  };

  const restart = async () => {
    setBusy(true);
    setMsg(null);
    const r = await api("vncrestart", {});
    setBusy(false);
    if (r.ok) {
      const d = r.data as Record<string, unknown> & { vnc?: VncInfo; note?: string; error?: string };
      if (d.vnc) setInfo(d.vnc);
      setMsg({ ok: true, text: (d.note as string) ?? "已重启" });
    } else {
      setMsg({ ok: false, text: (r.data.error as string) ?? "重启失败" });
    }
  };

  const running = info?.running ?? false;

  return (
    <div className="space-y-5">
      <div className={card}>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">tigervncserver 状态</span>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-lg bg-white/10 px-3 py-1 text-xs hover:bg-white/20"
          >
            刷新
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div className="rounded-lg bg-black/30 p-3">
            <div className="text-slate-500">运行状态</div>
            <div className={`mt-1 flex items-center gap-1.5 font-medium ${running ? "text-emerald-300" : "text-red-300"}`}>
              <span className={`inline-block h-2 w-2 rounded-full ${running ? "bg-emerald-400" : "bg-red-400"}`} />
              {running ? "运行中" : "未运行"}
            </div>
          </div>
          <div className="rounded-lg bg-black/30 p-3">
            <div className="text-slate-500">DISPLAY</div>
            <div className="mt-1 font-medium text-slate-200">{info?.display ?? "—"}</div>
          </div>
          <div className="rounded-lg bg-black/30 p-3">
            <div className="text-slate-500">RFB 端口</div>
            <div className="mt-1 font-medium text-slate-200">{info?.port ?? "—"}</div>
          </div>
          <div className="rounded-lg bg-black/30 p-3">
            <div className="text-slate-500">VNC 密码文件</div>
            <div className={`mt-1 font-medium ${info?.passwdSet ? "text-emerald-300" : "text-amber-300"}`}>
              {info?.passwdSet ? "已设置" : "未设置"}
            </div>
          </div>
        </div>
        {!running && (
          <div className="mt-3 rounded-lg bg-amber-500/10 p-3 text-xs text-amber-200">
            未检测到运行中的 VNC 服务。点下方「重启 VNC 服务」可直接拉起（
            <code className="text-amber-100">tigervncserver :1 -geometry 1024x576 -FrameRate 8 -AcceptSetDesktopSize 0</code>
            ），否则请先在服务器上自行启动。
          </div>
        )}
      </div>

      <div className={card}>
        <div className="mb-1 text-sm font-medium">设置 VNC 密码</div>
        <div className="mb-4 text-xs text-slate-500">
          写入 <code className="text-slate-400">~/.vnc/passwd</code>（本机浏览器登录后输入的就是这个密码）。<span className="text-amber-300">保存后需重启 tigervncserver 才生效。</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="新 VNC 密码（1–8 位字符）" className={input} autoComplete="new-password" />
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="再次输入" className={input} autoComplete="new-password" />
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !pw}
            className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
          >
            保存密码
          </button>
          <button
            type="button"
            onClick={() => void restart()}
            disabled={busy}
            className="rounded-lg bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/40 disabled:opacity-40"
          >
            {running ? "重启 VNC 服务" : "启动 VNC 服务"}
          </button>
        </div>
        {msg && (
          <div className={`mt-3 rounded-lg p-3 text-xs ${msg.ok ? "bg-emerald-500/10 text-emerald-200" : "bg-red-500/10 text-red-200"}`}>
            {msg.text}
          </div>
        )}
      </div>
    </div>
  );
}
