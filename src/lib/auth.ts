import crypto from "crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { adminUsers, authConfig } from "@/db/schema";

// 两套完全独立的登录：
//  - 桌面：一个访问密码（由后台设置），Cookie = wd_session
//  - 后台：独立的管理员账号 + 密码，Cookie = wd_admin
// 会话是带 HMAC 签名的令牌，签名密钥保存在数据库里；改密码 / 强制下线会让旧令牌立即失效。

export const DESKTOP_COOKIE = "wd_session";
export const ADMIN_COOKIE = "wd_admin";
// 后台路径：默认值不常见，可用环境变量 ADMIN_PATH 自定义
export const ADMIN_SLUG = (process.env.ADMIN_PATH || "ops-7k2m9x4q").replace(/^\/+|\/+$/g, "");
// 桌面会话时长：30 天。若后台设置了密码到期时间，则以到期时间为准（30天与密码到期取较早者）
export const DESKTOP_MAX_AGE = 7 * 24 * 3600;
export const DESKTOP_SHORT_AGE = 30 * 24 * 3600;
export const ADMIN_MAX_AGE = 12 * 3600;

/**
 * 桌面并发在线人数上限。
 * 旧版本只保存一个 desk_active，后登录的人会把先登录的人顶下线。
 * 现在允许多人同时在线，默认 3 个；可用环境变量 DESKTOP_MAX_SESSIONS 调整（1 ~ 50）。
 */
/**
 * 桌面并发在线人数上限。**0 = 不限制（默认）**。
 * 上游版本硬编码了「最多 3 人同时在线」，超过就把最早登录的人踢下线；
 * 现已删除该限制：不再按席位淘汰，任何数量的访问密码登录都可以同时在线。
 * 需要重新收紧时，设置 DESKTOP_MAX_SESSIONS=1（单人独占）或任意正整数。
 */
export const DESKTOP_MAX_SESSIONS = (() => {
  const raw = String(process.env.DESKTOP_MAX_SESSIONS ?? "0").trim().toLowerCase();
  if (raw === "" || raw === "0" || raw === "-1" || raw === "unlimited" || raw === "none" || raw === "off") return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1000, n);
})();

/** true = 不限制同时在线人数（默认） */
export const DESKTOP_UNLIMITED = DESKTOP_MAX_SESSIONS <= 0;

/**
 * 同一个浏览器 Cookie 里最多串联多少个令牌。
 * 服务端席位已不限制，这里单独设一个上限只是因为浏览器对单个 Cookie 有 4KB 限制；
 * 一个令牌约 170 字节，8 个约 1.4KB，远低于 4096，安全。
 */
const COOKIE_MAX_TOKENS = 8;

export const DEFAULT_ADMIN_USER = process.env.ADMIN_USER || "admin";
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Admin@Des11#2026";

type Try = { n: number; first: number; lock: number };
type State = {
  ready?: Promise<void>;
  secret?: string;
  cache: Map<string, { v: string | null; t: number }>;
  tries: Map<string, Try>;
};
const holder = globalThis as unknown as { __wdAuth?: State };
const S: State = (holder.__wdAuth ??= { cache: new Map(), tries: new Map() });

/* ---------------- 密码哈希 (scrypt) ---------------- */

function scrypt(pw: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))),
  );
}

export async function hashPassword(pw: string) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt);
  return `s1$${salt.toString("hex")}$${key.toString("hex")}`;
}

const DUMMY_HASH = "s1$00000000000000000000000000000000$" + "00".repeat(64);

export async function verifyPassword(pw: string, stored: string | null | undefined) {
  const parts = (stored ?? DUMMY_HASH).split("$");
  if (parts.length !== 3 || parts[0] !== "s1") return false;
  const key = await scrypt(pw, Buffer.from(parts[1], "hex"));
  const want = Buffer.from(parts[2], "hex");
  return want.length === key.length && crypto.timingSafeEqual(want, key) && stored != null;
}

/* ---------------- 数据库：建表 / 配置 ---------------- */

export function ensureAuthTables() {
  S.ready ??= (async () => {
    await db.execute(sql`create table if not exists auth_config (key text primary key, value text not null)`);
    await db.execute(sql`create table if not exists admin_users (
      id serial primary key,
      username text not null,
      password_hash text not null,
      must_change boolean not null default false,
      created_at timestamptz not null default now(),
      constraint admin_users_username_unique unique (username)
    )`);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(adminUsers);
    if (n === 0) {
      // 全新部署必须显式提供初始密码，不使用公开可猜的默认凭据。
      if (!INITIAL_ADMIN_PASSWORD) throw new Error("首次部署前请设置 ADMIN_PASSWORD 环境变量");
      await db
        .insert(adminUsers)
        .values({
          username: DEFAULT_ADMIN_USER,
          passwordHash: await hashPassword(INITIAL_ADMIN_PASSWORD),
          mustChange: false,
        })
        .onConflictDoNothing();
    }
  })().catch((e) => {
    S.ready = undefined;
    throw e;
  });
  return S.ready;
}

async function getCfg(key: string, ttl = 2000): Promise<string | null> {
  const hit = S.cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  await ensureAuthTables();
  const [row] = await db.select().from(authConfig).where(eq(authConfig.key, key));
  const v = row?.value ?? null;
  S.cache.set(key, { v, t: Date.now() });
  return v;
}

async function setCfg(key: string, value: string) {
  await ensureAuthTables();
  await db
    .insert(authConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: authConfig.key, set: { value } });
  S.cache.delete(key);
}

async function delCfg(key: string) {
  await ensureAuthTables();
  await db.delete(authConfig).where(eq(authConfig.key, key));
  S.cache.delete(key);
}

async function getSecret() {
  if (S.secret) return S.secret;
  await ensureAuthTables();
  let v = await getCfg("secret", 0);
  if (!v) {
    await db
      .insert(authConfig)
      .values({ key: "secret", value: crypto.randomBytes(32).toString("hex") })
      .onConflictDoNothing();
    S.cache.delete("secret");
    v = await getCfg("secret", 0);
  }
  S.secret = v!;
  return S.secret;
}

/* ---------------- 令牌 ---------------- */

async function sign(payload: object) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", await getSecret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

async function unsign<T extends { exp: number }>(token?: string | null): Promise<T | null> {
  if (!token || token.length > 2000) return null;
  const i = token.indexOf(".");
  if (i < 1) return null;
  const body = token.slice(0, i);
  const mac = Buffer.from(token.slice(i + 1));
  const want = Buffer.from(crypto.createHmac("sha256", await getSecret()).update(body).digest("base64url"));
  if (mac.length !== want.length || !crypto.timingSafeEqual(mac, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as T;
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

export function cookieValue(header: string | null | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function isHttps(req: Request) {
  const xf = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  if (xf) return xf === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function setCookieHeader(name: string, value: string, req: Request, maxAge?: number) {
  return (
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax` +
    (maxAge !== undefined ? `; Max-Age=${maxAge}` : "") +
    (isHttps(req) ? "; Secure" : "")
  );
}

export const clearCookieHeader = (name: string, req: Request) => setCookieHeader(name, "", req, 0);

/* ---------------- 桌面密码 / 会话 ---------------- */

export async function isDesktopPasswordSet() {
  return !!(await getCfg("desk_hash"));
}

/* 当前密码以 AES-256-GCM 加密后保存，供后台查看（密钥由服务端签名密钥派生，可用环境变量 AUTH_KEY 额外加固） */
async function encKey() {
  return crypto.createHash("sha256").update(`${await getSecret()}|${process.env.AUTH_KEY ?? ""}`).digest();
}

async function encryptText(plain: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", await encKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `e1$${iv.toString("base64url")}$${c.getAuthTag().toString("base64url")}$${ct.toString("base64url")}`;
}

async function decryptText(stored: string | null): Promise<string | null> {
  const p = stored?.split("$");
  if (!p || p.length !== 4 || p[0] !== "e1") return null;
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", await encKey(), Buffer.from(p[1], "base64url"));
    d.setAuthTag(Buffer.from(p[2], "base64url"));
    return Buffer.concat([d.update(Buffer.from(p[3], "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export type DesktopStatus = { set: boolean; setAt: number | null; expiresAt: number | null; expired: boolean };

/** 桌面密码状态：是否已设置、设置时间、到期时间、是否已过期 */
export async function getDesktopStatus(): Promise<DesktopStatus> {
  const set = !!(await getCfg("desk_hash"));
  const exp = Number((await getCfg("desk_expires")) ?? 0) || null;
  const setAt = Number((await getCfg("desk_set_at")) ?? 0) || null;
  return { set, setAt, expiresAt: exp, expired: set && !!exp && exp <= Date.now() };
}

export async function getDesktopPlain() {
  return decryptText(await getCfg("desk_plain", 0));
}

/** expiresAt = 到期时间戳(毫秒)，null = 永久有效 */
export async function setDesktopPassword(pw: string, expiresAt: number | null) {
  await setCfg("desk_hash", await hashPassword(pw));
  await setCfg("desk_plain", await encryptText(pw));
  await setCfg("desk_set_at", String(Date.now()));
  if (expiresAt) await setCfg("desk_expires", String(expiresAt));
  else await delCfg("desk_expires");
  await bumpDesktopVersion(); // 换密码 = 所有旧会话下线
}

/**
 * 桌面用户改密码：只更新密码相关字段，绝不修改 desk_expires。
 * 事务内重新验证旧密码与到期状态，避免两个改密请求并发时使用过期的旧密码。
 */
export async function changeDesktopPasswordKeepingExpiry(current: string, next: string): Promise<"ok" | "invalid" | "expired" | "unset"> {
  await ensureAuthTables();
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(28411, 1)`);
    const rows = await tx.select().from(authConfig).where(inArray(authConfig.key, ["desk_hash", "desk_expires", "desk_ver"]));
    const config = new Map(rows.map((row) => [row.key, row.value]));
    const stored = config.get("desk_hash");
    if (!stored) return "unset" as const;
    const expiresAt = Number(config.get("desk_expires") ?? 0);
    if (expiresAt && expiresAt <= Date.now()) return "expired" as const;
    if (!(await verifyPassword(current, stored))) return "invalid" as const;

    const hash = await hashPassword(next);
    const encrypted = await encryptText(next);
    const version = Number(config.get("desk_ver") ?? "1");
    const values = [
      { key: "desk_hash", value: hash },
      { key: "desk_plain", value: encrypted },
      { key: "desk_set_at", value: String(Date.now()) },
      { key: "desk_ver", value: String(Number.isFinite(version) ? version + 1 : 2) },
    ];
    for (const entry of values) {
      await tx.insert(authConfig).values(entry).onConflictDoUpdate({ target: authConfig.key, set: { value: entry.value } });
    }
    return "ok" as const;
  });
  if (result === "ok") {
    for (const key of ["desk_hash", "desk_plain", "desk_set_at", "desk_ver"]) S.cache.delete(key);
  }
  return result;
}

/** 只修改有效期，密码不变。如果密码已过期，旧会话仍然保持失效 */
export async function setDesktopExpiry(expiresAt: number | null) {
  const before = await getDesktopStatus();
  if (expiresAt) await setCfg("desk_expires", String(expiresAt));
  else await delCfg("desk_expires");
  if (before.expired) await bumpDesktopVersion();
}

export async function clearDesktopPassword() {
  for (const k of ["desk_hash", "desk_plain", "desk_set_at", "desk_expires"]) await delCfg(k);
  await bumpDesktopVersion();
}

export async function bumpDesktopVersion() {
  const cur = Number((await getCfg("desk_ver", 0)) ?? "1");
  await setCfg("desk_ver", String(cur + 1));
  // 版本号变化即代表所有旧令牌作废，顺带清空在线列表，立刻释放全部席位。
  await setCfg(ACTIVE_KEY, "[]");
}

export async function checkDesktopPassword(pw: string) {
  return verifyPassword(pw, await getCfg("desk_hash", 0));
}

/* ---------------- 桌面在线会话列表（支持多人同时登录） ---------------- */

const ACTIVE_KEY = "desk_active";

export type ActiveDesktopSession = { sid: string; at: number; exp: number; seen: number };

/**
 * 解析 auth_config.desk_active。
 * 新格式：JSON 数组 [{ sid, at, exp }]
 * 旧格式：单个会话标识字符串（升级部署时自动兼容，不会把已登录的人踢掉）
 */
function parseActiveSessions(raw: string | null | undefined): ActiveDesktopSession[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      const out: ActiveDesktopSession[] = [];
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        const sid = typeof row.sid === "string" ? row.sid : "";
        if (!sid || sid.length > 128) continue;
        const at = Number(row.at);
        const exp = Number(row.exp);
        out.push({
          sid,
          at: Number.isFinite(at) ? at : 0,
          exp: Number.isFinite(exp) ? exp : 0,
          seen: 0,
        });
      }
      return out;
    } catch {
      return [];
    }
  }
  // 旧版单会话格式：保留该会话，给一个默认到期时间。seen=0 表示"还没打过心跳"。
  return [{ sid: text, at: 0, exp: Date.now() + DESKTOP_SHORT_AGE * 1000, seen: 0 }];
}

/** 去掉已过期 / 重复的会话，并按登录时间从旧到新排序 */
function normalizeActiveSessions(list: ActiveDesktopSession[], now = Date.now()) {
  const seenSet = new Set<string>();
  return list
    .filter((s) => s.sid && s.exp > now && !seenSet.has(s.sid) && seenSet.add(s.sid) !== undefined)
    .sort((a, b) => a.at - b.at);
}

// 打过心跳的会话：多久没心跳就算"这个网页已经没了"。
// 关页面时前端会主动登出，这里只兜底崩溃 / 进程被杀 / 平台把标签页冻住的情况，所以放得很宽：
// 浏览器把后台标签页冻住一两个小时再切回来是常事，掐太紧会把"只是隐身一小时"的在线用户当幽灵踢掉。
const SESSION_STALE_MS = 60 * 60_000;
// 升级前登录、还没有打过心跳的老会话：只给这点举证时间。
// 真正开着的网页心跳是 8 秒一次，几秒内就能自己证明还活着；攒下来的幽灵会话则很快被清掉。
const LEGACY_GRACE_MS = 2 * 60_000;

/** 没有心跳记录的会话（seen<=0）只能拿登录时间凑合判断 */
function lastSeen(s: ActiveDesktopSession) {
  return s.seen > 0 ? s.seen : s.at;
}

/** 幽灵会话 = 占着席位不放、其实早就没有一个网页在连着 */
function isAlive(s: ActiveDesktopSession, now: number) {
  const limit = s.seen > 0 ? SESSION_STALE_MS : LEGACY_GRACE_MS;
  return now - lastSeen(s) < limit;
}

/**
 * 心跳：告诉服务端"我这个网页还在"，同时回收幽灵会话。
 * 自己的 sid 一定会被刷新，不会自己把自己清掉。
 */
export async function touchDesktopSession(sid?: string | null) {
  if (!sid) return;
  await ensureAuthTables();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(28411, 3)`);
    const [row] = await tx.select().from(authConfig).where(eq(authConfig.key, ACTIVE_KEY));
    const now = Date.now();
    const list = normalizeActiveSessions(parseActiveSessions(row?.value), now);
    const own = list.find((s) => s.sid === sid);
    // 已经被登出 / 被淘汰掉的会话：没什么可刷新的
    if (!own) return;
    // 只回收"打过心跳之后失联"的幽灵；升级前登录的老会话没有心跳记录，
    // 交给登录时的举证期判断，否则升级后第一次心跳就可能把还在用的老会话误杀。
    const prunable = (s: ActiveDesktopSession) =>
      s.seen > 0 && now - s.seen >= SESSION_STALE_MS;
    // 3 秒内刚刷过、也没有幽灵要清：不白写一次库（心跳是每 8 秒一次）
    if (now - own.seen < 3000 && !list.some((s) => s.sid !== sid && prunable(s))) return;
    const next = list
      .filter((s) => s.sid === sid || !prunable(s))
      .map((s) => (s.sid === sid ? { ...s, seen: now } : s));
    await tx
      .insert(authConfig)
      .values({ key: ACTIVE_KEY, value: JSON.stringify(next) })
      .onConflictDoUpdate({ target: authConfig.key, set: { value: JSON.stringify(next) } });
  });
  S.cache.delete(ACTIVE_KEY);
}

/** 当前在线的桌面会话（已剔除过期项） */
export async function listDesktopSessions(): Promise<ActiveDesktopSession[]> {
  return normalizeActiveSessions(parseActiveSessions(await getCfg(ACTIVE_KEY, 0)));
}

/** 在线人数 / 上限，供后台展示（只算还活着的，幽灵会话不算人头） */
export async function getDesktopSeats() {
  const sessions = await listDesktopSessions();
  const now = Date.now();
  const live = sessions.filter((s) => isAlive(s, now));
  return { online: live.length, max: DESKTOP_MAX_SESSIONS, sessions: live };
}

/** 退出登录：只移除自己的会话，其他人不受影响，并立即释放一个席位 */
export async function revokeDesktopSession(sid?: string | null) {
  if (!sid) return;
  await ensureAuthTables();
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(28411, 2)`);
    const [row] = await tx.select().from(authConfig).where(eq(authConfig.key, ACTIVE_KEY));
    const next = normalizeActiveSessions(parseActiveSessions(row?.value)).filter((s) => s.sid !== sid);
    await tx
      .insert(authConfig)
      .values({ key: ACTIVE_KEY, value: JSON.stringify(next) })
      .onConflictDoUpdate({ target: authConfig.key, set: { value: JSON.stringify(next) } });
  });
  S.cache.delete(ACTIVE_KEY);
}

// 每次成功登录生成新的随机会话。活跃会话记录在 PostgreSQL 中，不依赖单个 Node 进程的内存。
// 同一个浏览器的不同标签共享 Cookie，因此还要求每页自己的随机会话标识。
export async function createDesktopToken(password: string) {
  await ensureAuthTables();
  const sessionId = crypto.randomBytes(24).toString("base64url");
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(28411, 1)`);
    const rows = await tx
      .select()
      .from(authConfig)
      .where(inArray(authConfig.key, ["desk_hash", "desk_ver", "desk_expires", ACTIVE_KEY]));
    const config = new Map(rows.map((row) => [row.key, row.value]));
    if (!(await verifyPassword(password, config.get("desk_hash")))) return null;
    const now = Date.now();
    const passwordExpiry = Number(config.get("desk_expires") ?? 0);
    if (passwordExpiry && passwordExpiry <= now) return null;
    // token 到期 = min(30天后, 密码到期)；密码永久有效时固定 30 天。
    const longExpiry = now + DESKTOP_SHORT_AGE * 1000;
    const expiry = passwordExpiry ? Math.min(longExpiry, passwordExpiry) : longExpiry;

    // 多人同时在线：把新会话加入在线列表。
    // 超过上限时按「先登录先下线」(FIFO) 淘汰最早的那个，保证席位数恒等于 DESKTOP_MAX_SESSIONS。
    const current = normalizeActiveSessions(parseActiveSessions(config.get(ACTIVE_KEY)), now)
      .filter((s) => isAlive(s, now));
    current.push({ sid: sessionId, at: now, exp: expiry, seen: now });
    // 默认不限制人数：不淘汰任何人；只有显式配置了 DESKTOP_MAX_SESSIONS>0 才按 FIFO 淘汰。
    const kept = DESKTOP_UNLIMITED ? current : current.slice(-DESKTOP_MAX_SESSIONS);
    const evicted = current.length - kept.length;
    const value = JSON.stringify(kept);
    await tx
      .insert(authConfig)
      .values({ key: ACTIVE_KEY, value })
      .onConflictDoUpdate({ target: authConfig.key, set: { value } });
    return { version: config.get("desk_ver") ?? "1", expiry, online: kept.length, evicted };
  });
  S.cache.delete(ACTIVE_KEY);
  if (!result) return null;
  return {
    token: await sign({ k: "d", exp: result.expiry, v: result.version, sid: sessionId }),
    sessionId,
    online: result.online,
    max: DESKTOP_MAX_SESSIONS,
    evicted: result.evicted,
  };
}

/* ---------------- 桌面 Cookie：可同时承载多个令牌 ---------------- */
// 同一个浏览器里 Cookie 是共享的。旧版本一个 Cookie 只放一个令牌，
// 所以第二个标签页登录会覆盖第一个标签页的令牌。
// 现在 Cookie 里用 "~" 串联最多 DESKTOP_MAX_SESSIONS 个令牌，
// 校验时只要有任意一个令牌与本页面的会话标识匹配即可 —— 多标签 / 多设备都能并存。

const COOKIE_SEP = "~";

export function splitDesktopCookie(raw?: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(COOKIE_SEP)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part.length <= 2000)
    .slice(-COOKIE_MAX_TOKENS);
}

/** 登录成功后把新令牌并入原有 Cookie（超出 Cookie 容量上限时丢弃最旧的） */
export function mergeDesktopCookie(raw: string | null | undefined, token: string) {
  const list = splitDesktopCookie(raw).filter((t) => t !== token);
  list.push(token);
  return list.slice(-COOKIE_MAX_TOKENS).join(COOKIE_SEP);
}

/** 退出登录时只摘掉自己那一个令牌，同浏览器其他标签页仍然有效 */
export async function dropDesktopCookieToken(raw: string | null | undefined, sessionId: string | null) {
  const list = splitDesktopCookie(raw);
  if (!sessionId) return list.join(COOKIE_SEP);
  const kept: string[] = [];
  for (const token of list) {
    const p = await unsign<{ k: string; exp: number; sid?: string }>(token).catch(() => null);
    if (p && p.k === "d" && p.sid === sessionId) continue;
    kept.push(token);
  }
  return kept.join(COOKIE_SEP);
}

export async function verifyDesktopToken(cookieToken?: string | null, sessionId?: string | null) {
  if (!sessionId || sessionId.length > 128) return false;
  const tokens = splitDesktopCookie(cookieToken);
  if (tokens.length === 0) return false;

  let payload: { k: string; exp: number; v: string; sid?: string } | null = null;
  for (const token of tokens) {
    const p = await unsign<{ k: string; exp: number; v: string; sid?: string }>(token);
    if (p && p.k === "d" && p.sid === sessionId) {
      payload = p;
      break;
    }
  }
  if (!payload) return false;

  const st = await getDesktopStatus();
  if (!st.set || st.expired) return false;
  if (payload.v !== ((await getCfg("desk_ver", 0)) ?? "1")) return false;
  // 只要自己的会话还在在线列表里就算有效，不再要求「全局唯一」。
  const sessions = normalizeActiveSessions(parseActiveSessions(await getCfg(ACTIVE_KEY, 0)));
  return sessions.some((s) => s.sid === payload.sid);
}

export function requestDesktopSession(req: Request) {
  // 图片、音频、视频及下载链接无法添加自定义请求头，使用同源 URL 查询参数。
  return req.headers.get("x-desktop-session") ?? new URL(req.url).searchParams.get("access");
}

/** API 路由守卫：Cookie + 此页面独有的会话标识必须同时匹配。 */
export async function denyDesktop(req: Request): Promise<Response | null> {
  try {
    if (await verifyDesktopToken(cookieValue(req.headers.get("cookie"), DESKTOP_COOKIE), requestDesktopSession(req))) return null;
  } catch {
    return Response.json({ error: "服务暂时不可用，请稍后重试" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json(
    {
      error: DESKTOP_UNLIMITED
        ? "登录已过期（可能被管理员强制下线，或访问密码已变更），请重新输入密码"
        : `登录已过期，或在线人数已满（最多 ${DESKTOP_MAX_SESSIONS} 人同时在线）被挤下线，请重新输入密码`,
    },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/** WebSocket 升级请求及定期续验均同时检查 Cookie 与原页面会话标识。 */
export async function desktopAuthedHeader(cookieHeader: string | undefined, sessionId: string | null) {
  try {
    return await verifyDesktopToken(cookieValue(cookieHeader, DESKTOP_COOKIE), sessionId);
  } catch {
    return false;
  }
}

/** 与上面相同，但数据库暂时故障时不误杀仍在运行的进程。 */
export async function desktopAuthState(cookieHeader: string | undefined, sessionId: string | null): Promise<boolean | null> {
  try {
    return await verifyDesktopToken(cookieValue(cookieHeader, DESKTOP_COOKIE), sessionId);
  } catch {
    return null;
  }
}

/* ---------------- 后台管理员 ---------------- */

export type AdminUser = typeof adminUsers.$inferSelect;

const fp = (hash: string) => crypto.createHash("sha256").update(hash).digest("hex").slice(0, 16);

export async function findAdminByName(name: string) {
  await ensureAuthTables();
  const [u] = await db.select().from(adminUsers).where(eq(adminUsers.username, name));
  return u as AdminUser | undefined;
}

export async function createAdminToken(u: AdminUser) {
  const sessionId = crypto.randomBytes(24).toString("base64url");
  const key = `admin_active_${u.id}`;
  await setCfg(key, sessionId);
  return {
    token: await sign({ k: "a", exp: Date.now() + ADMIN_MAX_AGE * 1000, uid: u.id, fp: fp(u.passwordHash), sid: sessionId }),
    sessionId,
  };
}

export async function verifyAdminToken(token?: string | null, sessionId?: string | null): Promise<AdminUser | null> {
  if (sessionId && sessionId.length > 128) return null;
  const p = await unsign<{ k: string; exp: number; uid: number; fp: string; sid?: string }>(token);
  if (!p || p.k !== "a") return null;
  const sid = sessionId || p.sid;
  if (!sid || p.sid !== sid) return null;
  await ensureAuthTables();
  const [u] = await db.select().from(adminUsers).where(eq(adminUsers.id, p.uid));
  if (!u || fp(u.passwordHash) !== p.fp) return null;
  return (await getCfg(`admin_active_${u.id}`, 0)) === sid ? u : null;
}

export async function requireAdmin(req: Request) {
  try {
    return await verifyAdminToken(cookieValue(req.headers.get("cookie"), ADMIN_COOKIE), req.headers.get("x-admin-session"));
  } catch {
    return null;
  }
}

export async function updateAdmin(id: number, patch: { username?: string; password?: string }) {
  const set: Partial<typeof adminUsers.$inferInsert> = {};
  if (patch.username) set.username = patch.username;
  if (patch.password) {
    set.passwordHash = await hashPassword(patch.password);
    set.mustChange = false;
  }
  const [u] = await db.update(adminUsers).set(set).where(eq(adminUsers.id, id)).returning();
  return u as AdminUser;
}

/* ---------------- 登录限速（防暴力破解） ---------------- */

export function clientIp(req: Request) {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",").pop()!.trim() || "unknown";
  return req.headers.get("x-real-ip") || "unknown";
}

const WINDOW = 15 * 60_000;
const LOCK = 10 * 60_000;

function trying(key: string) {
  const now = Date.now();
  let t = S.tries.get(key);
  if (!t || (t.lock < now && now - t.first > WINDOW)) {
    t = { n: 0, first: now, lock: 0 };
    S.tries.set(key, t);
  }
  if (S.tries.size > 5000) for (const [k, v] of S.tries) if (v.lock < now && now - v.first > WINDOW) S.tries.delete(k);
  return t;
}

/** 返回需要等待的秒数（0 = 可以尝试） */
export function lockedFor(scope: string, ip: string) {
  const now = Date.now();
  const left = Math.max(trying(`${scope}:ip:${ip}`).lock, trying(`${scope}:all`).lock) - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export function recordFailure(scope: string, ip: string) {
  const now = Date.now();
  const a = trying(`${scope}:ip:${ip}`);
  a.n++;
  if (a.n >= 5) a.lock = now + LOCK;
  const g = trying(`${scope}:all`); // 全局计数：防止伪造来源地址绕过
  g.n++;
  if (g.n >= 40) g.lock = now + 5 * 60_000;
}

export function recordSuccess(scope: string, ip: string) {
  S.tries.delete(`${scope}:ip:${ip}`);
}

export function remainingAttempts(scope: string, ip: string) {
  return Math.max(0, 5 - trying(`${scope}:ip:${ip}`).n);
}
