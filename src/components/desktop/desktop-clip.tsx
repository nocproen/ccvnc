"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// 模拟桌面自己的剪贴板，和本机（Windows / macOS）剪贴板彻底分成两块。
//
// 以前"复制路径"、终端里 Ctrl+C、远程浏览器里复制选中文本，全都直接写 navigator.clipboard，
// 于是：在模拟桌面里复制一次，你本机刚复制的东西就被覆盖掉；而本机复制的东西回到模拟桌面按"粘贴"，
// 又可能被桌面里的剪贴板内容顶掉 —— 两块剪贴板互相抢，怎么用都别扭。
//
// 现在：桌面内部的复制只进这里（内存 + BroadcastChannel，多个标签页共享），
// 只有用户明确点"复制到本机剪贴板"时才动 navigator.clipboard。

export type ClipText = { text: string; at: number } | null;

/** 把文本写进本机剪贴板（execCommand 兜底），成功返回 true */
export async function writeTextToLocal(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 浏览器拒绝 / 不支持异步接口时用老办法兜底
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

type ClipApi = {
  text: ClipText;
  /** 桌面内部复制：不碰本机剪贴板 */
  copy: (text: string) => void;
  /** 明确要把文本送到本机剪贴板（用户点按钮时才会走到） */
  copyToLocal: (text: string) => Promise<boolean>;
  clear: () => void;
};

const Ctx = createContext<ClipApi | null>(null);

const CHANNEL = "webdesktop-clipboard";

export function useClip() {
  const v = useContext(Ctx);
  if (!v) throw new Error("ClipProvider missing");
  return v;
}

export function ClipProvider({ children }: { children: ReactNode }) {
  const [text, setText] = useState<ClipText>(null);
  const channel = useRef<BroadcastChannel | null>(null);

  const broadcast = useCallback((next: ClipText) => {
    try {
      channel.current ??= new BroadcastChannel(CHANNEL);
      channel.current.postMessage({ text: next });
    } catch {
      // 浏览器不支持 / 被禁用时：只有本标签页能看到，不影响功能
    }
  }, []);

  // 其他标签页复制了东西，这边也跟着更新（桌面本来就是多网页共用的）
  useEffect(() => {
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel(CHANNEL);
      bc.onmessage = (e: MessageEvent<{ text?: ClipText }>) => {
        if (e.data && "text" in e.data) setText(e.data.text ?? null);
      };
    } catch {
      bc = null;
    }
    channel.current = bc;
    return () => {
      bc?.close();
      channel.current = null;
    };
  }, []);

  const api = useMemo<ClipApi>(
    () => ({
      text,
      copy: (t) => {
        const next: ClipText = { text: t, at: Date.now() };
        setText(next);
        broadcast(next);
      },
      copyToLocal: (t) => writeTextToLocal(t),
      clear: () => {
        setText(null);
        broadcast(null);
      },
    }),
    [text, broadcast],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
