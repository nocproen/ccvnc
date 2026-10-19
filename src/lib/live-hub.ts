// 进程内的实时广播总线：桌面快照 / 设置 / 云盘变更后推给所有在线网页。
// 状态挂在 globalThis 上：Next 的每个路由是独立打包的，模块级变量不保证共享，
// 只有 globalThis 能在同一个 Node 进程里真正共用（与 lib/gui.ts 的做法一致）。

export type LiveMessage =
  | { type: "workspace"; version: number; snapshot: unknown }
  | { type: "settings"; key: string; value: string }
  | { type: "fs" };

type Listener = (msg: LiveMessage) => void;

type Hub = {
  listeners: Set<Listener>;
  // 每个订阅者都可能慢（慢网 / 代理缓冲），逐个发送时出错不能影响其他人
  seq: number;
};

const holder = globalThis as unknown as { __wdLive?: Hub };
const H: Hub = (holder.__wdLive ??= { listeners: new Set(), seq: 0 });

export function subscribeLive(fn: Listener) {
  H.listeners.add(fn);
  return () => {
    H.listeners.delete(fn);
  };
}

export function publishLive(msg: LiveMessage) {
  H.seq++;
  for (const fn of [...H.listeners]) {
    try {
      fn(msg);
    } catch {
      // 单个订阅者断开（网页关闭 / 网络抖动）不影响其他人
    }
  }
}

export function liveClientCount() {
  return H.listeners.size;
}
