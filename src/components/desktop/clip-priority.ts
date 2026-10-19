"use client";

// 两块剪贴板的优先级判断。
//
// 桌面内部复制（文件 / 路径 / 文本）和本机剪贴板互不覆盖，但按 Ctrl+V 时总得有个先后。
// 规则：**谁的动作更新就以谁为准**。
//   • 在模拟桌面里复制后，用户没离开过浏览器（没 alt-tab 去别的程序）→ 桌面剪贴板是最新动作，优先它；
//   • 用户离开过浏览器（通常是去本地复制了东西）再回来按 Ctrl+V → 本机剪贴板是最新动作，优先它。
//
// 判断依据：页面失焦（blur / 标签页隐藏）的时间戳 vs 桌面剪贴板内容的时间戳。
// 点击本页内的其他窗口不会让页面失焦，“复制完直接粘进 VNC / 终端”的流程不受影响。

let lastBlurAt = 0;

if (typeof window !== "undefined") {
  const mark = () => {
    lastBlurAt = Date.now();
  };
  window.addEventListener("blur", mark);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) mark();
  });
}

/** 桌面剪贴板（ts 为写入时间）是否比用户最后一次离开浏览器更近 */
export function desktopClipIsFresher(ts: number): boolean {
  return ts > lastBlurAt;
}
