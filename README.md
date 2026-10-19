# des11 WebDesktop（多人并发登录版）

基于 Next.js 16 + PostgreSQL + Drizzle ORM 的网页桌面系统。
本仓库在上游 [nocproen/des11](https://github.com/nocproen/des11.git) 基础上做了两件事：

1. **补全运行环境**（依赖、壁纸资源、`.env`、数据库表、修复原有 TypeScript 编译错误）
2. **把「只能一个人登录」改成「最多 3 个人同时在线」**（人数可配置）

---

## 一、一键部署

```bash
# 全自动部署（默认 3 人同时在线）
curl -fsSL https://raw.githubusercontent.com/nocproen/des11/master/scripts/deploy.sh -o deploy.sh
bash deploy.sh

# 或在已克隆的目录里就地部署
bash scripts/deploy.sh
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--port 8080` | 监听端口（默认 3000） |
| `--max-sessions 5` | **同时在线人数**（1 = 旧的单人独占模式） |
| `--db-url postgresql://u:p@host:5432/db` | 使用外部 PostgreSQL，跳过本机安装 |
| `--desktop-password xxx` / `--admin-password xxx` | 指定密码（默认随机生成并在结尾打印） |
| `--admin-path ops-xxxx` | 后台入口路径 |
| `--dir /opt/des11` | 安装目录 |
| `--skip-deps` | 跳过系统依赖安装 |
| `--no-systemd` | 不注册 systemd，用 nohup 后台运行 |
| `--update` | 拉取最新代码 → 重建 → 重启 |
| `--uninstall` | 停止并移除服务（保留代码与数据） |

脚本的通用性设计：

* 自动识别 **apt / dnf / yum / apk / pacman / zypper / brew**，覆盖 Debian、Ubuntu、CentOS、Rocky、Alma、Fedora、Alpine、Arch、openSUSE、macOS
* Node.js < 20 时先走系统源，失败自动回退到 **nodejs.org 官方二进制**（x64 / arm64）
* PostgreSQL 自动安装、initdb、建库建用户；也可直接接外部数据库
* 有 root / systemd 就注册系统服务；**没有 root 也能跑**（装到 `~/des11`，用 nohup 启动）
* **幂等**：重复执行不会覆盖已经在用的密码，只补齐缺失项
* 结尾自动做 `/api/health` 健康检查并打印访问地址与全部凭据

---

## 二、多人同时登录改造说明

### 改造前（单人独占）

`auth_config` 表里只有一个 `desk_active` 字段保存**唯一**的会话标识。
任何人登录都会覆盖它 → 之前登录的人下一次心跳（8 秒内）立刻被踢下线。
另外浏览器端还有一个 `BroadcastChannel("webdesktop-exclusive-session")`，
会主动把同一浏览器的其他标签页踢掉。

### 改造后（默认 3 人）

| 位置 | 改动 |
| --- | --- |
| `src/lib/auth.ts` | `desk_active` 由「单个字符串」改为 **JSON 会话数组** `[{sid, at, exp}]`；新增 `DESKTOP_MAX_SESSIONS`（默认 3，范围 1–50） |
| `createDesktopToken()` | 事务 + 咨询锁内把新会话 **追加** 进列表；超过上限时按 **FIFO** 淘汰最早登录的那一个 |
| `verifyDesktopToken()` | 从「必须等于唯一的 `desk_active`」改为「**存在于在线列表中即有效**」 |
| Cookie | 一个 Cookie 用 `~` 串联最多 N 个令牌（`mergeDesktopCookie`），**同一浏览器的多个标签页也能各自登录** |
| `/api/auth/logout` | 只注销自己的会话与自己的那个令牌，**立即释放一个席位**，其他人不受影响 |
| `/api/auth/session` | 额外返回 `{ online, max }`，前端可显示「2/3 人在线」 |
| `client-session.ts` | **移除** 同浏览器互踢的 `BroadcastChannel` 逻辑 |
| 后台面板 | 新增「在线人数 `online / max`」展示 |
| 兼容性 | 旧格式的 `desk_active`（纯字符串）会被自动识别并保留，升级部署不会把已登录的人踢掉 |

安全性保持不变：

* 会话仍是 HMAC-SHA256 签名令牌，密钥存库
* 仍然要求 `HttpOnly Cookie` + 页面内存中的随机会话标识 **双因子** 匹配
* 改密码 / 改有效期 / 后台「强制所有人下线」会 bump `desk_ver` 并清空在线列表，**一次性踢掉全部 N 个人**
* 登录限速、锁定策略完全保留

### 多网页实时同步（模拟桌面共用一份屏幕）

所有网页共用 `desktop_workspace` 里的一份屏幕快照。之前只有"打开网页时读一次"，
所以同时开两个网页时，一个网页开的窗口 / 拖的位置，另一个网页完全不知道。现在的做法：

| 位置 | 改动 |
| --- | --- |
| `src/lib/live-hub.ts` | 进程内广播总线（挂 `globalThis`，跨路由模块共享） |
| `src/app/api/workspace/stream/route.ts` | 新增 **SSE** 通道 `/api/workspace/stream`：连上先推当前快照，之后任何写入即时广播；20 秒心跳防代理断连 |
| `src/app/api/workspace/route.ts` | 写入成功后广播；新增 `?meta=1` 只返回版本号（廉价对版本）；**删除 `force` 强制写入**（旧标签页关页时不再覆盖别人的桌面） |
| `wm-store.tsx` | 订阅实时通道；收到新版本即套用；409 冲突时按窗口 id **合并**而不是覆盖；正在拖拽/输入时延后套用，避免窗口"跳回去"；每 20 秒 + 切回前台各兜底对一次版本 |
| `window.tsx` | 窗口坐标改为**渲染时按本视口裁剪**，不再把裁剪后的坐标写回数据库（小屏网页不会把大屏的窗口越改越小） |
| `api/settings` + `fs-store.tsx` | 壁纸 / 主题色 / 时钟格式变更即时同步到其他网页 |
| `api/fs` + `fs-store.tsx` | 云盘文件增删改即时同步（自己刚写过的请求会被忽略，不会来回刷） |
| `term-ws.ts` + `systerm-app.tsx` | 终端会话 id 改为由**窗口 id** 派生，同一个终端窗口在哪个网页连的都是同一个 shell（刷新/换网页不会重开）；多网页同看时由第一个连上的网页决定行列数，其余网页按真实尺寸排版，不会互抢 |

冲突合并规则：以服务器版本为准，但**本地最近 1.5 秒内动过的窗口**（拖拽 / 缩放 / 新开 / 关闭）保留本地版本，
避免两个人同时操作时互相把对方正在拖的窗口弹回去。

> 如果前面套了 nginx，需要给这条流关掉缓冲：`proxy_buffering off;`（服务端已返回 `X-Accel-Buffering: no`）。
> 即使流被代理掐断，网页也会每 20 秒对一次版本号，最终仍会同步。

### 在线席位与心跳（修复“没满 3 人也被挤下线”）

`desk_active` 以前只增不减：前端只在任务栏点“退出登录”时才注销，**关标签页 / 刷新页面不会**，
而每次打开桌面都要重新登录一次 → 每刷新一次就往列表里多留一个没人用的会话。
攒够 3 个之后，下一个登录就会按 FIFO 把“最早登录的那个”踢下线——
如果最早那个恰好是你一直开着的标签页，就出现**明明没到 3 人在线却被挤下线**。

| 位置 | 改动 |
| --- | --- |
| `desktop-client.tsx` | 监听 `pagehide`：关标签页 / 刷新 / 导航离开时立刻 `POST /api/auth/logout`（`keepalive`，`persisted` 的 bfcache 情况跳过），把席位还回去 |
| `auth.ts` | 会话记录新增 `seen`（最后一次心跳）；新增 `touchDesktopSession()`：刷新自己的 `seen`，并回收“打过心跳后失联”的会话 |
| `api/auth/session` | 沿用原有的 8 秒轮询当作心跳：每次请求都会 `touchDesktopSession()` |
| `auth.ts` `createDesktopToken` | 算席位时先剔掉幽灵会话，只按**活着的**会话数判断是否要淘汰 |
| `auth.ts` `getDesktopSeats` | 后台面板的“在线人数”也只数活着的 |

活性阈值：打过心跳的会话 **60 分钟**没心跳才算幽灵（关页面已经会主动登出，这里只兜底崩溃 / 进程被杀，
浏览器把后台标签页冻住一小时再切回来的情况不能误杀）；升级前登录、还没有 `seen` 字段的老会话给 **2 分钟**举证期，
真正开着的网页 8 秒内就能自己证明还活着，不会因为升级被踢。

### 剪贴板：Ctrl+C / Ctrl+V 只走本机（修复两块剪贴板互相抢）

以前“复制路径”、终端里 Ctrl+C、远程浏览器里复制选中文本，全都直接写 `navigator.clipboard`，
于是：**在模拟桌面里复制一次，你本机刚复制的东西就被覆盖掉**；而本机复制的东西回到模拟桌面按“粘贴”，
又可能被桌面里的剪贴板内容顶掉——两块剪贴板互相抢，怎么用都别扭。

现在的规则一句话：**键盘上的 Ctrl+C / Ctrl+V 只在本机剪贴板和模拟桌面之间流转**——

| 按键 | 行为 |
| --- | --- |
| Ctrl+C（终端 / 远程浏览器，有选中内容） | 选中内容写进**本机剪贴板**（哪都能粘） |
| Ctrl+C（终端，无选中） | 照旧当中断键（SIGINT）发给 shell |
| Ctrl+V（终端 / VNC 应用 / 远程浏览器） | 只粘**本机剪贴板**：文字直接进应用，图片上传后粘进 VNC |
| Ctrl+V（桌面 / 文件夹） | 只粘**本机剪贴板里的文件 / 图片**，粘贴成服务器上的真实文件（也可以直接拖进来） |
| Ctrl+V（VNC 应用，本机剪贴板为空） | 把 Ctrl+V 转给远程应用，粘它自己剪贴板里的内容 |

模拟桌面内部那块剪贴板**不再抢占键盘快捷键**，只保留在明确的菜单 / 按钮里：

| 入口 | 说明 |
| --- | --- |
| 右键「复制 / 剪切」文件、桌面图标 Ctrl+C/X | 复制的是**服务器上的文件**（浏览器没法把服务器文件放进你的本机剪贴板，这是唯一载体）；粘进文件夹或 VNC 应用 |
| 右键「复制路径」/「复制路径到本机剪贴板」 | 一个只进桌面剪贴板，一个明确送到本机 |
| 任务栏 📋 按钮 | 预览桌面剪贴板、复制到本机、从本机粘贴到桌面、清空 |
| VNC 窗口右下角 📋 | 把桌面里复制的文件粘进当前 VNC 应用（Ctrl+V 不干这个） |
| VNC 窗口右下角 ⤵ | 把 VNC 应用里复制的文本取回本机剪贴板 |
| VNC 窗口右下角 📋 ⤵ 拼 中 | 这一排小按钮可以整体拖动移开，位置自动记住，双击复位 |

| 位置 | 改动 |
| --- | --- |
| `desktop-clip.tsx` | 桌面自己的剪贴板 Context（跨标签页同步）+ 带兜底的 `writeTextToLocal()` |
| `systerm-app.tsx` | Ctrl+C 有选中 → 写本机剪贴板；Ctrl+V 只读本机；去掉 Ctrl+Shift+C/V 自定义键 |
| `browser-app.tsx` | Ctrl+C 把远程选中的文字写进本机剪贴板；Ctrl+V 走浏览器原生 paste 事件（本就是本机文本） |
| `gui-app.tsx` | VNC 窗口 Ctrl+V 只读本机剪贴板（图片上传 / 文字送远程），为空才转交远程；去掉 Ctrl+Shift+V，⤵ 按钮保留 |
| `desktop.tsx` / `sysfiles-app.tsx` | 普通“复制”（含图片）只写桌面剪贴板，不再顺手写本机；另加“复制路径 / 复制图片到本机剪贴板” |
| `sys-store.tsx` + `api/gui/clipboard` | “清空桌面剪贴板”只清桌面内部这一块（VNC 内部同步的那份也一起清） |

这样：**本地复制的东西随时能粘进模拟桌面；模拟桌面里复制的东西会进本机剪贴板；两块各走各的路，不再互相覆盖。**

### 调整人数

```bash
# 方式一：改 .env 后重启
DESKTOP_MAX_SESSIONS=5

# 方式二：用部署脚本
bash scripts/deploy.sh --max-sessions 5
```

`DESKTOP_MAX_SESSIONS=1` 即可完全恢复成原来的单人独占行为。

---

## 三、手动部署

```bash
cp .env.example .env    # 填好 DATABASE_URL / ADMIN_PASSWORD / DESKTOP_PASSWORD
npm install
npx drizzle-kit push
npm run build
npm run start
```

* 桌面： `http://<host>:<port>/`
* 后台： `http://<host>:<port>/<ADMIN_PATH>`
* 健康检查： `http://<host>:<port>/api/health`
