#!/usr/bin/env bash
# ============================================================
# MarkFlow 一键部署（Ubuntu 服务器）
#
#   git clone https://github.com/Kutbas/MarkFlow.git
#   cd MarkFlow && sudo bash deploy.sh
#
# 重复执行 = 升级：拉取最新代码 → 重建镜像 → 滚动重启（数据卷保留）。
# 产物：http://127.0.0.1:8080（默认只绑回环，配合 1Panel/Nginx 反代对外）。
# ============================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Kutbas/MarkFlow.git}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # 脚本所在目录 = 仓库根
COMPOSE_DIR="$APP_DIR/docker"
ENV_FILE="$COMPOSE_DIR/.env"
PORT="${PORT:-8080}"

log()  { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy] 错误:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------- 0. 前置检查 ----------
[[ $EUID -eq 0 ]] || die "请用 sudo 运行（需要操作 docker）"

if ! command -v docker >/dev/null 2>&1; then
  log "未检测到 Docker，开始安装（get.docker.com 官方脚本）…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi
docker info >/dev/null 2>&1 || die "Docker 已安装但未运行：systemctl start docker"

# compose v2 插件或独立二进制均可
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "未找到 docker compose（v2 插件）。Ubuntu: apt-get install -y docker-compose-plugin"
fi

# ---------- 1. 代码更新（首装后重复执行即为升级） ----------
cd "$APP_DIR"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  log "拉取最新代码…"
  git pull --ff-only || warn "git pull 失败（本地有改动或网络问题），继续使用当前代码"
else
  log "当前目录不是 git 仓库，克隆 $REPO_URL …"
  cd "$(dirname "$APP_DIR")"
  git clone "$REPO_URL" "$(basename "$APP_DIR")"
fi

# ---------- 2. 生成部署密钥（仅首次；已存在绝不覆盖） ----------
cd "$COMPOSE_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
  ADMIN_PASS="$(openssl rand -hex 8)" # 16 位随机口令
  cat > "$ENV_FILE" <<EOF
# MarkFlow 部署配置（deploy.sh 首次生成；修改后 docker compose up -d 生效）
JWT_SECRET=$(openssl rand -hex 32)
PG_PASSWORD=$(openssl rand -hex 16)
AUTH_USERS=admin:${ADMIN_PASS}
# 对外监听：默认 127.0.0.1（走反向代理）；改 0.0.0.0 可局域网直连
# BIND=127.0.0.1
EOF
  chmod 600 "$ENV_FILE"
  log "已生成 $ENV_FILE（随机 JWT/数据库密码/管理员口令）"
  GENERATED_PASS=1
else
  log "沿用已有 $ENV_FILE"
fi

# ---------- 3. 构建并启动（PG healthcheck 就绪后应用才起） ----------
log "构建镜像并启动（首次构建需数分钟）…"
$COMPOSE up -d --build

# ---------- 4. 健康等待 ----------
log "等待应用就绪（/api/health）…"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  [[ $i -eq 60 ]] && { $COMPOSE ps; $COMPOSE logs --tail 50 markflow; die "应用 60s 内未就绪，查看上方日志"; }
  sleep 1
done

# ---------- 5. 收尾信息 ----------
SERVER_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
log "✅ 部署完成：容器 markflow + markflow-postgres 均已运行"
echo "    本机访问:   http://127.0.0.1:${PORT}"
[[ -n "${SERVER_IP:-}" ]] && echo "    局域网地址: http://${SERVER_IP}:${PORT}（需 BIND=0.0.0.0 并重新 up）"
echo
if [[ "${GENERATED_PASS:-0}" -eq 1 ]]; then
  echo "    🔑 初始账号: admin"
  echo "       初始密码: $(grep -oP 'AUTH_USERS=admin:\K.*' "$ENV_FILE")"
  echo "       （密码仅此一次展示，保存在 $ENV_FILE，可随时修改后 docker compose up -d）"
fi
echo
echo "    下一步（可选）：用 1Panel/OpenResty 反向代理域名 → 127.0.0.1:${PORT}"
echo "    反代需放行 WebSocket（/collab）与 SSE（/api/events），详见 README「服务器部署」。"
echo
$COMPOSE ps
