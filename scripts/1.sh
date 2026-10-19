#!/usr/bin/env bash
# =============================================================================
#  des11 WebDesktop 一键部署脚本（改良版，修复Next16 + sharp + Node版本坑）
#
#  支持：Debian/Ubuntu、RHEL/CentOS/Rocky/Alma/Fedora、Alpine、Arch、openSUSE、macOS
#  能力：自动装依赖 -> 拉代码 -> 建库建用户 -> 写 .env -> 建表 -> 构建 -> 注册服务 -> 启动 -> 健康检查
#  特性：幂等（可重复执行）、不覆盖已有密码、支持纯用户态运行（无 root / 无 systemd 亦可）
#  新增：sharp兼容模式，自动降级sharp@0.32.6 + 修复tiles.ts kernel类型错误
#
#  快速使用：
#      bash deploy.sh                                          # 全自动，默认 3 人同时在线，开启sharp兼容
#      bash deploy.sh --port 8080 --max-sessions 5              # 自定义端口与并发人数
#      bash deploy.sh --db-url postgresql://u:p@h:5432/d        # 使用外部数据库
#      bash deploy.sh --update                                  # 仅拉取更新并重建重启
#      bash deploy.sh --uninstall                              # 卸载服务（保留数据）
#      bash deploy.sh --no-sharp-compat                         # 关闭sharp兼容（使用原版最新sharp，需要Node>=20.10）
# =============================================================================
set -Eeuo pipefail
# ----------------------------- 可配置项（均可用环境变量或参数覆盖） ----------
APP_NAME="${APP_NAME:-des11}"
REPO_URL="${REPO_URL:-https://github.com/nocproen/des11.git}"
REPO_BRANCH="${REPO_BRANCH:-}"                 # 留空 = 远端默认分支
APP_DIR="${APP_DIR:-}"                        # 留空 = 自动推断
PORT="${PORT:-3000}"
BIND_HOST="${BIND_HOST:-0.0.0.0}"
DATABASE_URL="${DATABASE_URL:-}"               # 留空 = 本机自动创建 PostgreSQL
DB_NAME="${DB_NAME:-des11}"
DB_USER="${DB_USER:-des11}"
DB_PASSWORD="${DB_PASSWORD:-}"
DESKTOP_PASSWORD="${DESKTOP_PASSWORD:-}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_PATH="${ADMIN_PATH:-}"
DESKTOP_MAX_SESSIONS="${DESKTOP_MAX_SESSIONS:-3}"   # ★ 同时在线人数，默认 3
NODE_MAJOR="${NODE_MAJOR:-22}"
SKIP_DEPS="${SKIP_DEPS:-0}"
USE_SYSTEMD="${USE_SYSTEMD:-auto}"
SHARP_COMPAT=1 # 默认开启sharp兼容模式（sharp@0.32.6 + 自动修复TS代码）
MODE="install"
# ----------------------------- 输出工具 -------------------------------------
if [[ -t 1 ]]; then C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_C=$'\033[36m'; C_0=$'\033[0m'
else C_B=""; C_G=""; C_Y=""; C_R=""; C_C=""; C_0=""; fi
log()  { printf '%s\n' "${C_C}==>${C_0} ${C_B}$*${C_0}"; }
ok()   { printf '%s\n' "${C_G} ok${C_0}  $*"; }
warn() { printf '%s\n' "${C_Y} !!${C_0}  $*" >&2; }
die()  { printf '%s\n' "${C_R}FAIL${C_0} $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
trap 'die "部署在第 $LINENO 行中断。请查看上方输出排查。"' ERR
# ----------------------------- 参数解析 -------------------------------------
usage() {
  cat <<EOF
${C_B}des11 WebDesktop 一键部署脚本【改良版】${C_0}
用法: bash $0 [选项]
  --dir <路径>                安装目录（默认 /opt/${APP_NAME} 或 ~/${APP_NAME}）
  --repo <git地址>            源码仓库（默认 ${REPO_URL}）
  --branch <分支>             指定分支
  --port <端口>               监听端口（默认 3000）
  --host <地址>               监听地址（默认 0.0.0.0）
  --db-url <连接串>           使用外部 PostgreSQL，跳过本机安装
  --db-name/--db-user/--db-password
                              本机自动建库时使用的库名/用户/密码
  --desktop-password <密码>   桌面访问密码（默认随机生成并打印）
  --admin-user <账号>         后台账号（默认 admin）
  --admin-password <密码>     后台密码（默认随机生成并打印）
  --admin-path <路径>         后台入口路径（默认随机生成）
  --max-sessions <N>          ★ 允许同时在线的人数，默认 3（1 = 旧的单人模式）
  --node-major <版本>         需要的 Node 主版本（默认 22）
  --skip-deps                 跳过系统依赖安装（已自备 node/git/psql 时使用）
  --no-systemd                不注册 systemd，使用 nohup 后台运行
  --no-sharp-compat           关闭sharp兼容模式（使用最新sharp，Node >=20.10）
  --update                    仅更新代码并重建重启
  --uninstall                 停止并移除服务（不删除代码与数据）
  -h, --help                  显示本帮助
EOF
}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) APP_DIR="$2"; shift 2;;
    --repo) REPO_URL="$2"; shift 2;;
    --branch) REPO_BRANCH="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --host) BIND_HOST="$2"; shift 2;;
    --db-url) DATABASE_URL="$2"; shift 2;;
    --db-name) DB_NAME="$2"; shift 2;;
    --db-user) DB_USER="$2"; shift 2;;
    --db-password) DB_PASSWORD="$2"; shift 2;;
    --desktop-password) DESKTOP_PASSWORD="$2"; shift 2;;
    --admin-user) ADMIN_USER="$2"; shift 2;;
    --admin-password) ADMIN_PASSWORD="$2"; shift 2;;
    --admin-path) ADMIN_PATH="$2"; shift 2;;
    --max-sessions) DESKTOP_MAX_SESSIONS="$2"; shift 2;;
    --node-major) NODE_MAJOR="$2"; shift 2;;
    --skip-deps) SKIP_DEPS=1; shift;;
    --no-systemd) USE_SYSTEMD="no"; shift;;
    --no-sharp-compat) SHARP_COMPAT=0; shift;;
    --update) MODE="update"; shift;;
    --uninstall) MODE="uninstall"; shift;;
    -h|--help) usage; exit 0;;
    *) die "未知参数：$1（用 --help 查看用法）";;
  esac
done
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "端口无效：$PORT"
[[ "$DESKTOP_MAX_SESSIONS" =~ ^[0-9]+$ ]] && (( DESKTOP_MAX_SESSIONS >= 1 && DESKTOP_MAX_SESSIONS <= 50 )) \
  || die "--max-sessions 需为 1~50 的整数（当前：$DESKTOP_MAX_SESSIONS）"
# ----------------------------- 环境探测 -------------------------------------
IS_ROOT=0; [[ "$(id -u)" == "0" ]] && IS_ROOT=1
SUDO=""
if (( ! IS_ROOT )) && have sudo; then SUDO="sudo"; fi
as_root() { if (( IS_ROOT )); then "$@"; elif [[ -n "$SUDO" ]]; then $SUDO "$@"; else return 1; fi; }
OS="$(uname -s)"
PKG=""
case "$OS" in
  Linux)
    if   have apt-get; then PKG="apt"
    elif have dnf;     then PKG="dnf"
    elif have yum;     then PKG="yum"
    elif have apk;     then PKG="apk"
    elif have pacman;  then PKG="pacman"
    elif have zypper;  then PKG="zypper"
    fi;;
  Darwin) have brew && PKG="brew";;
esac
if [[ -z "$APP_DIR" ]]; then
  APP_DIR="./app"
fi
if [[ "$USE_SYSTEMD" == "auto" ]]; then
  if have systemctl && [[ -d /run/systemd/system ]] && { (( IS_ROOT )) || [[ -n "$SUDO" ]]; }; then
    USE_SYSTEMD="yes"
  else
    USE_SYSTEMD="no"
  fi
fi
SERVICE_NAME="${APP_NAME}.service"
PID_FILE="${APP_DIR}/.run/app.pid"
LOG_FILE="${APP_DIR}/.run/app.log"
rand() { # rand <字节数>  -> URL 安全随机串
  if have openssl; then openssl rand -base64 "$((${1:-24} * 2))" | tr -dc 'A-Za-z0-9' | head -c "${1:-24}"
  else head -c 256 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c "${1:-24}"; fi
}
# ----------------------------- 卸载 -----------------------------------------
if [[ "$MODE" == "uninstall" ]]; then
  log "停止并卸载服务 ${SERVICE_NAME}"
  if have systemctl; then
    as_root systemctl stop "$SERVICE_NAME" 2>/dev/null || true
    as_root systemctl disable "$SERVICE_NAME" 2>/dev/null || true
    as_root rm -f "/etc/systemd/system/${SERVICE_NAME}" 2>/dev/null || true
    as_root systemctl daemon-reload 2>/dev/null || true
  fi
  [[ -f "$PID_FILE" ]] && { kill "$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; }
  ok "服务已移除。代码与数据库仍保留在 ${APP_DIR}"
  exit 0
fi
# ----------------------------- 1. 系统依赖 ----------------------------------
install_system_deps() {
  (( SKIP_DEPS )) && { warn "--skip-deps：跳过系统依赖安装"; return 0; }
  [[ -z "$PKG" ]] && { warn "未识别包管理器，跳过依赖安装（请自行准备 git / node>=20 / psql）"; return 0; }
  local base_pkgs=()
  case "$PKG" in
    apt)    base_pkgs=(git curl ca-certificates python3 make g++ iproute2);;
    dnf|yum)base_pkgs=(git curl ca-certificates python3 make gcc-c++ iproute);;
    apk)    base_pkgs=(git curl ca-certificates python3 make g++ bash iproute2);;
    pacman) base_pkgs=(git curl ca-certificates python make gcc iproute2);;
    zypper) base_pkgs=(git curl ca-certificates python3 make gcc-c++ iproute2);;
    brew)   base_pkgs=(git);;
  esac
  log "安装基础依赖（$PKG）"
  case "$PKG" in
    apt)    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
            as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${base_pkgs[@]}" || warn "部分基础依赖安装失败";;
    dnf)    as_root dnf install -y -q "${base_pkgs[@]}" || warn "部分基础依赖安装失败";;
    yum)    as_root yum install -y -q "${base_pkgs[@]}" || warn "部分基础依赖安装失败";;
    apk)    as_root apk add --no-cache "${base_pkgs[@]}" || warn "部分基础依赖安装失败";;
    pacman) as_root pacman -Sy --noconfirm --needed "${base_pkgs[@]}" || warn "部分基础依赖安装失败";;
    zypper) as_root zypper --non-interactive install "${base_pkgs[@]}" || warn "部分基础依赖安装失败";;
    brew)   brew install "${base_pkgs[@]}" || warn "部分基础依赖安装失败";;
  esac
  ok "基础依赖就绪"
}
node_major_version() { have node && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
install_node() {
  local cur; cur="$(node_major_version)"
  if (( cur >= 20 )); then ok "系统Node.js v$(node -v | tr -d v) 已存在；脚本优先使用项目内置node"; fi
  (( SKIP_DEPS )) && { warn "--skip-deps：跳过Node安装"; return 0; }
  log "安装 Node.js ${NODE_MAJOR}.x 到项目本地目录 ${APP_DIR}/.node（避免系统PATH冲突）"
  local arch tarball
  case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) die "不支持的 CPU 架构：$(uname -m)";; esac
  tarball="$(curl -fsSL https://nodejs.org/dist/index.json | grep -o "\"version\":\"v${NODE_MAJOR}\.[0-9.]*\"" | head -1 | cut -d'"' -f4)"
  [[ -n "$tarball" ]] || die "无法确定 Node.js 版本，请手动安装 Node >= 20"
  mkdir -p "${APP_DIR}/.node"
  curl -fsSL "https://nodejs.org/dist/${tarball}/node-${tarball}-linux-${arch}.tar.xz" \
    | tar -xJ -C "${APP_DIR}/.node" --strip-components=1
  export PATH="${APP_DIR}/.node/bin:$PATH"
  ok "项目内置Node：$(node -v)"
}
# ----------------------------- 2. PostgreSQL --------------------------------
pg_running() { have pg_isready && pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; }
install_postgres() {
  [[ -n "$DATABASE_URL" ]] && { ok "使用外部数据库，跳过 PostgreSQL 安装"; return 0; }
  if pg_running; then ok "检测到本机已有 PostgreSQL"; else
    (( SKIP_DEPS )) && die "本机无可用 PostgreSQL，且指定了 --skip-deps；请改用 --db-url"
    log "安装 PostgreSQL"
    case "$PKG" in
      apt)    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql postgresql-contrib;;
      dnf)    as_root dnf install -y -q postgresql-server postgresql-contrib
              [[ -d /var/lib/pgsql/data/base ]] || as_root postgresql-setup --initdb >/dev/null 2>&1 || true;;
      yum)    as_root yum install -y -q postgresql-server postgresql-contrib
              [[ -d /var/lib/pgsql/data/base ]] || as_root postgresql-setup initdb >/dev/null 2>&1 || true;;
      apk)    as_root apk add --no-cache postgresql postgresql-contrib
              as_root mkdir -p /var/lib/postgresql/data /run/postgresql
              as_root chown -R postgres:postgres /var/lib/postgresql /run/postgresql
              as_root su postgres -c "initdb -D /var/lib/postgresql/data" >/dev/null 2>&1 || true
              as_root su postgres -c "pg_ctl -D /var/lib/postgresql/data -l /tmp/pg.log start" >/dev/null 2>&1 || true;;
      pacman) as_root pacman -Sy --noconfirm --needed postgresql
              as_root su postgres -c "initdb -D /var/lib/postgres/data" >/dev/null 2>&1 || true;;
      zypper) as_root zypper --non-interactive install postgresql-server;;
      brew)   brew install postgresql@16 && brew services start postgresql@16 || true;;
      *)      die "无法自动安装 PostgreSQL，请改用 --db-url 指定外部数据库";;
    esac
    if have systemctl && [[ -d /run/systemd/system ]]; then
      as_root systemctl enable --now postgresql >/dev/null 2>&1 || as_root systemctl start postgresql >/dev/null 2>&1 || true
    elif have rc-service; then
      as_root rc-service postgresql start >/dev/null 2>&1 || true
    fi
    for _ in $(seq 1 30); do pg_running && break; sleep 1; done
    pg_running || die "PostgreSQL 启动失败，请手动启动后重试，或使用 --db-url"
  fi
  ok "PostgreSQL 可用"
}
psql_super() { # 以超级用户执行 SQL
  if (( IS_ROOT )) || [[ -n "$SUDO" ]]; then
    as_root su - postgres -c "psql -v ON_ERROR_STOP=1 -tAc \"$1\"" 2>/dev/null && return 0
  fi
  if have psql; then psql -v ON_ERROR_STOP=1 -tAc "$1" postgres 2>/dev/null && return 0; fi
  return 1
}
provision_database() {
  [[ -n "$DATABASE_URL" ]] && return 0
  [[ -z "$DB_PASSWORD" ]] && DB_PASSWORD="$(rand 24)"
  log "准备数据库 ${DB_NAME} / 用户 ${DB_USER}"
  if psql_super "select 1" >/dev/null 2>&1; then
    if [[ "$(psql_super "select 1 from pg_roles where rolname='${DB_USER}'" || true)" == "1" ]]; then
      psql_super "alter role ${DB_USER} with login password '${DB_PASSWORD}'" >/dev/null
    else
      psql_super "create role ${DB_USER} with login password '${DB_PASSWORD}'" >/dev/null
    fi
    if [[ "$(psql_super "select 1 from pg_database where datname='${DB_NAME}'" || true)" != "1" ]]; then
      psql_super "create database ${DB_NAME} owner ${DB_USER}" >/dev/null
    fi
    psql_super "grant all privileges on database ${DB_NAME} to ${DB_USER}" >/dev/null || true
    DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}"
  else
    warn "无法以超级用户连接 PostgreSQL，回退使用 postgres/postgres 默认账号"
    DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/${DB_NAME}"
  fi
  ok "数据库连接已就绪"
}
# ----------------------------- 3. 源码 --------------------------------------
fetch_source() {
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P || echo "")"
  if [[ -n "$here" && -f "${here}/package.json" && -d "${here}/src/app" ]]; then
    # 脚本本身就在项目里：原地部署
    APP_DIR="$here"
    ok "就地部署：${APP_DIR}"
    if [[ -d "${APP_DIR}/.git" && "$MODE" == "update" ]]; then
      log "拉取最新代码"
      git -C "$APP_DIR" fetch --all --prune
      git -C "$APP_DIR" reset --hard "origin/$(git -C "$APP_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null | cut -d/ -f2- || echo HEAD)" || true
    fi
    return 0
  fi
  if [[ -d "${APP_DIR}/.git" ]]; then
    log "更新已有仓库：${APP_DIR}"
    git -C "$APP_DIR" fetch --all --prune
    if [[ -n "$REPO_BRANCH" ]]; then
      git -C "$APP_DIR" checkout "$REPO_BRANCH"
      git -C "$APP_DIR" reset --hard "origin/${REPO_BRANCH}"
    else
      git -C "$APP_DIR" pull --ff-only || warn "快进更新失败，保留当前代码"
    fi
  else
    log "克隆仓库到 ${APP_DIR}"
    mkdir -p "$(dirname "$APP_DIR")" 2>/dev/null || as_root mkdir -p "$(dirname "$APP_DIR")"
    if [[ ! -w "$(dirname "$APP_DIR")" ]]; then
      as_root mkdir -p "$APP_DIR"; as_root chown -R "$(id -un):$(id -gn)" "$APP_DIR"
    fi
    if [[ -n "$REPO_BRANCH" ]]; then git clone --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
    else git clone "$REPO_URL" "$APP_DIR"; fi
  fi
  # 修复权限：确保项目目录属主为当前用户，防止后续EACCES
  as_root chown -R "$(id -un):$(id -gn)" "$APP_DIR" || true
  ok "源码就绪，目录权限已修复"
}

# ----------------------------- 新增：sharp兼容修补逻辑 ----------------------
patch_sharp_compat() {
  if (( SHARP_COMPAT == 0 )); then
    log "跳过sharp兼容修补"
    return 0
  fi
  log "【sharp兼容模式】锁定sharp@0.32.6，自动修复src/lib/tiles.ts kernel:linear"
  local tiles_file="${APP_DIR}/src/lib/tiles.ts"
  if [[ -f "$tiles_file" ]]; then
    # 将 kernel:"linear" 替换为 kernel:"lanczos2"
    sed -i 's/kernel: "linear"/kernel: "lanczos2"/g' "$tiles_file"
    ok "tiles.ts 类型修复完成"
  else
    warn "未找到 ${tiles_file}，跳过TS代码修补"
  fi

  # 可选：修改next.config.js，关闭图片优化，彻底不加载sharp
  local nextcfg="${APP_DIR}/next.config.js"
  if [[ ! -f "$nextcfg" ]]; then
    cat > "$nextcfg" <<EOF
/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true }
}
module.exports = nextConfig
EOF
    ok "生成next.config.js，关闭图片优化"
  else
    # 追加images.unoptimized，如果不存在
    if ! grep -q "unoptimized: true" "$nextcfg"; then
      sed -i '/nextConfig = {/a \  images: { unoptimized: true },' "$nextcfg"
      ok "已在next.config.js开启unoptimized图片模式"
    fi
  fi
}

# ----------------------------- 4. .env --------------------------------------
env_get() { [[ -f "${APP_DIR}/.env" ]] && sed -n "s/^${1}=//p" "${APP_DIR}/.env" | tail -1 || true; }
write_env() {
  local envf="${APP_DIR}/.env"
  touch "$envf"; chmod 600 "$envf"
  # 已有值优先保留，保证重复执行不会改掉用户已在用的密码
  DATABASE_URL="${DATABASE_URL:-$(env_get DATABASE_URL)}"
  DESKTOP_PASSWORD="${DESKTOP_PASSWORD:-$(env_get DESKTOP_PASSWORD)}"
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(env_get ADMIN_PASSWORD)}"
  ADMIN_PATH="${ADMIN_PATH:-$(env_get ADMIN_PATH)}"
  local auth_key; auth_key="$(env_get AUTH_KEY)"
  GENERATED_DESKTOP=0; GENERATED_ADMIN=0
  [[ -z "$DESKTOP_PASSWORD" ]] && { DESKTOP_PASSWORD="$(rand 16)"; GENERATED_DESKTOP=1; }
  [[ -z "$ADMIN_PASSWORD"   ]] && { ADMIN_PASSWORD="$(rand 20)";   GENERATED_ADMIN=1; }
  [[ -z "$ADMIN_PATH"       ]] && ADMIN_PATH="ops-$(rand 10 | tr 'A-Z' 'a-z')"
  [[ -z "$auth_key"         ]] && auth_key="$(rand 48)"
  log "写入环境配置 ${envf}"
  cat > "$envf" <<EOF
# 由 scripts/deploy.sh 于 $(date '+%F %T') 生成 / 更新
DATABASE_URL=${DATABASE_URL}
ADMIN_USER=${ADMIN_USER}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
ADMIN_PATH=${ADMIN_PATH}
DESKTOP_PASSWORD=${DESKTOP_PASSWORD}
AUTH_KEY=${auth_key}
# ★ 允许同时在线的人数（1 = 单人独占的旧行为）
DESKTOP_MAX_SESSIONS=${DESKTOP_MAX_SESSIONS}
BIND_HOST=${BIND_HOST}
PORT=${PORT}
UPSTREAM_REPOSITORY=${REPO_URL}
AUTO_UPDATE=0
UPDATE_RESTART=0
UPDATE_INTERVAL_MIN=10
EOF
  chmod 600 "$envf"
  ok "环境配置完成（并发在线上限 = ${DESKTOP_MAX_SESSIONS}）"
}
# ----------------------------- 5. 构建 --------------------------------------
build_app() {
  cd "$APP_DIR"
  # 强制优先项目内置node，彻底规避系统旧node
  export PATH="${APP_DIR}/.node/bin:$PATH"
  log "安装 npm 依赖（首次较慢，请耐心等待）"
  cd "$APP_DIR"
  if (( SHARP_COMPAT == 1 )); then
    # sharp兼容模式：先安装锁定版本
    npm install sharp@0.32.6 --no-audit --no-fund
  fi
  if [[ -f package-lock.json ]]; then npm ci --no-audit --no-fund || npm install --no-audit --no-fund
  else npm install --no-audit --no-fund; fi
  ok "依赖安装完成"
  log "同步数据库表结构"
  npx --yes drizzle-kit push --force || npx --yes drizzle-kit push || die "数据库表结构同步失败，请检查 DATABASE_URL"
  ok "数据库表结构已同步"
  log "构建生产版本"
  npm run build || die "构建失败"
  ok "构建完成"
}
# ----------------------------- 6. 启动 --------------------------------------
stop_running() {
  if [[ "$USE_SYSTEMD" == "yes" ]]; then as_root systemctl stop "$SERVICE_NAME" 2>/dev/null || true; fi
  if [[ -f "$PID_FILE" ]]; then kill "$(cat "$PID_FILE")" 2>/dev/null || true; sleep 1; rm -f "$PID_FILE"; fi
}
start_systemd() {
  log "注册 systemd 服务 ${SERVICE_NAME}"
  local node_bin; node_bin="${APP_DIR}/.node/bin/npm"
  as_root tee "/etc/systemd/system/${SERVICE_NAME}" >/dev/null <<EOF
[Unit]
Description=${APP_NAME} WebDesktop
After=network.target postgresql.service
Wants=postgresql.service
[Service]
Type=simple
User=$(id -un)
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
Environment=NODE_ENV=production
# 强制优先项目内置node，不再读取系统PATH旧node
Environment=PATH=${APP_DIR}/.node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=${node_bin} run start
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=20
[Install]
WantedBy=multi-user.target
EOF
  as_root systemctl daemon-reload
  as_root systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  as_root systemctl restart "$SERVICE_NAME"
  ok "服务已启动（systemctl status ${SERVICE_NAME}）"
}
start_nohup() {
  log "以后台进程方式启动（无 systemd）"
  mkdir -p "${APP_DIR}/.run"
  cd "$APP_DIR"
  set -a; # shellcheck disable=SC1091
  . "${APP_DIR}/.env"; set +a
  export NODE_ENV=production PATH="${APP_DIR}/.node/bin:$PATH"
  nohup npm run start >"$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  ok "已启动，PID=$(cat "$PID_FILE")，日志：${LOG_FILE}"
}
health_check() {
  log "健康检查 http://127.0.0.1:${PORT}/api/health"
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then ok "服务已就绪（${i}s）"; return 0; fi
    sleep 1
  done
  warn "健康检查超时。请查看日志："
  [[ "$USE_SYSTEMD" == "yes" ]] && echo "    journalctl -u ${SERVICE_NAME} -n 100 --no-pager" || echo "    tail -n 100 ${LOG_FILE}"
  return 1
}
# ----------------------------- 主流程 ---------------------------------------
echo
printf '%s\n' "${C_B}=========================================================${C_0}"
printf '%s\n' "${C_B}  des11 WebDesktop 一键部署【改良sharp兼容版】 | 并发上限: ${DESKTOP_MAX_SESSIONS}${C_0}"
printf '%s\n' "${C_B}=========================================================${C_0}"
echo
install_system_deps
install_node
fetch_source
# 新增：拉取源码后立刻修补代码
patch_sharp_compat
install_postgres
provision_database
write_env
build_app
stop_running
if [[ "$USE_SYSTEMD" == "yes" ]]; then start_systemd; else start_nohup; fi
health_check || true
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; [[ -z "$IP" ]] && IP="127.0.0.1"
echo
printf '%s\n' "${C_G}=========================================================${C_0}"
printf '%s\n' "${C_G}  部署完成${C_0}"
printf '%s\n' "${C_G}=========================================================${C_0}"
echo "  安装目录    : ${APP_DIR}"
echo "  桌面地址    : http://${IP}:${PORT}/"
echo "  后台地址    : http://${IP}:${PORT}/$(env_get ADMIN_PATH)"
echo "  后台账号    : ${ADMIN_USER}"
echo "  后台密码    : $(env_get ADMIN_PASSWORD)"
echo "  桌面密码    : $(env_get DESKTOP_PASSWORD)"
echo "  同时在线    : 最多 ${DESKTOP_MAX_SESSIONS} 人（超出时最早登录者自动下线）"
echo
if [[ "$USE_SYSTEMD" == "yes" ]]; then
  echo "  查看状态    : systemctl status ${SERVICE_NAME}"
  echo "  查看日志    : journalctl -u ${SERVICE_NAME} -f"
  echo "  重启服务    : systemctl restart ${SERVICE_NAME}"
else
  echo "  查看日志    : tail -f ${LOG_FILE}"
  echo "  停止服务    : kill \$(cat ${PID_FILE})"
fi
echo "  更新升级    : bash ${APP_DIR}/scripts/deploy.sh --update"
echo "  改并发人数  : bash ${APP_DIR}/scripts/deploy.sh --max-sessions 5"
echo
warn "请尽快登录后台修改默认密码，并通过防火墙/反向代理限制访问来源。"
