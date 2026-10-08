#!/bin/bash
# ============================================================
# MarkFlow 一键启动：PostgreSQL + 后端 + 前端
# 用法：cd ~/ZCode_Workspace/MarkFlow && ./start.sh
# ============================================================
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$HOME/.local/share/fnm/node-versions/v24.19.0/installation/bin"
export PATH="$HOME/.local/bin:$PATH"

# 颜色
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✓]${NC} $1"; }
wait()  { echo -e "${YELLOW}[…]${NC} $1"; }
fail()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# ---------- 1. PostgreSQL（Docker 容器） ----------
if ! docker info >/dev/null 2>&1; then
    wait "启动 Docker Desktop…"
    open -a Docker
    for i in $(seq 1 30); do
        docker info >/dev/null 2>&1 && break
        sleep 3
    done
    docker info >/dev/null 2>&1 || fail "Docker 未就绪（请手动打开 Docker Desktop 后重试）"
fi
info "Docker 就绪"

if docker ps -a --format '{{.Names}}' | grep -q '^markflow-pg$'; then
    docker start markflow-pg >/dev/null 2>&1 || true
else
    wait "创建 PostgreSQL 容器…"
    docker run -d --name markflow-pg -p 5432:5432 \
        -e POSTGRES_USER=markflow -e POSTGRES_PASSWORD=markflow -e POSTGRES_DB=markflow \
        postgres:17-alpine >/dev/null
fi
for i in $(seq 1 15); do
    docker exec markflow-pg pg_isready -U markflow >/dev/null 2>&1 && break
    sleep 2
done
docker exec markflow-pg pg_isready -U markflow >/dev/null 2>&1 || fail "PostgreSQL 未就绪"
info "PostgreSQL 就绪 (:5432)"

# ---------- 2. 清理残留进程 ----------
lsof -ti :8080 2>/dev/null | xargs kill -9 2>/dev/null || true
lsof -ti :5173 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

# ---------- 3. 后端（Express + Hocuspocus，端口 8080） ----------
cd "$DIR/server"
nohup "$NODE_BIN/npx" tsx src/index.ts > /tmp/mf-server.log 2>&1 &
SERVER_PID=$!
wait "启动后端 (:8080)…"
for i in $(seq 1 20); do
    curl -s http://127.0.0.1:8080/api/health | grep -q '"ok"' && break
    sleep 1
done
curl -s http://127.0.0.1:8080/api/health | grep -q '"ok"' || fail "后端启动失败（查看 /tmp/mf-server.log）"
info "后端就绪 → http://127.0.0.1:8080"

# ---------- 4. 前端（Vite --host，端口 5173） ----------
cd "$DIR/web"
nohup "$NODE_BIN/npx" vite --port 5173 --host > /tmp/mf-web.log 2>&1 &
wait "启动前端 (:5173)…"
for i in $(seq 1 20); do
    curl -s -o /dev/null -w '' http://127.0.0.1:5173/ 2>/dev/null && break
    sleep 1
done
curl -s -o /dev/null http://127.0.0.1:5173/ || fail "前端启动失败（查看 /tmp/mf-web.log）"
info "前端就绪 → http://127.0.0.1:5173"

# ---------- 5. 汇总 ----------
IP=$(ipconfig getifaddr en0 2>/dev/null || echo "127.0.0.1")
echo ""
echo "=========================================="
echo -e "${GREEN} MarkFlow 已全部启动${NC}"
echo "=========================================="
echo "  本机访问:  http://localhost:5173"
if [ "$IP" != "127.0.0.1" ]; then
    echo "  局域网:    http://$IP:5173"
fi
echo "  账号:      admin/admin123 或 alice/alice123"
echo "  日志:      /tmp/mf-server.log /tmp/mf-web.log"
echo "  停止:      ./stop.sh"
echo "=========================================="
