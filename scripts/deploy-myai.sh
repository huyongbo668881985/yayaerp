#!/usr/bin/env bash
set -euo pipefail

HOST="${DEPLOY_HOST:-myai}"
REMOTE_DIR="/home/ubuntu/yayaerp"
BACKUP_ROOT="/home/ubuntu/jxc-deploy-backups"
PUBLIC_HEALTHZ_URL="${PUBLIC_HEALTHZ_URL:-https://erp.yayaagent.com/healthz}"

echo "==> [1/2] 在 ${HOST} 执行备份、拉取、构建与内网验收..."
ssh "$HOST" bash -s -- "$REMOTE_DIR" "$BACKUP_ROOT" <<'REMOTE_EOF'
set -euo pipefail
REMOTE_DIR="$1"
BACKUP_ROOT="$2"

mkdir -p "$BACKUP_ROOT"
BACKUP_DIR="${BACKUP_ROOT}/backup-$(date +%Y%m%d%H%M%S)"
sudo cp -r "${REMOTE_DIR}/data" "$BACKUP_DIR"
echo "数据快照已备份至: ${BACKUP_DIR}"

cd "$REMOTE_DIR"

if [ ! -f .env ]; then
  echo "ERROR: 缺少 ${REMOTE_DIR}/.env" >&2
  exit 1
fi

BIND_ADDR="$(grep -E '^BIND_ADDR=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]'\''\"')"
if [ -z "$BIND_ADDR" ] || [ "$BIND_ADDR" = "127.0.0.1" ]; then
  echo "ERROR: .env 中的 BIND_ADDR 未正确配置（当前为 '${BIND_ADDR}'），不得为 127.0.0.1，否则 NPM 反代将 502" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "ERROR: 服务器仓库存在未提交的本地修改，请先清理后再部署" >&2
  git status --short >&2
  exit 1
fi

git pull --ff-only origin main
docker compose build
docker compose up -d

PORT_BIND="$(docker compose port jxc 3000 || true)"
EXPECTED_BIND="${BIND_ADDR}:3000"
if [ "$PORT_BIND" != "$EXPECTED_BIND" ]; then
  echo "ERROR: 端口映射异常，期望 '${EXPECTED_BIND}'，实际 '${PORT_BIND}'" >&2
  docker compose ps >&2
  exit 1
fi
echo "端口映射校验通过: ${PORT_BIND}"

HEALTH_HOST="$BIND_ADDR"
if [ "$HEALTH_HOST" = "0.0.0.0" ]; then
  HEALTH_HOST="127.0.0.1"
fi

HEALTH_OK=0
for _ in $(seq 1 15); do
  if curl -fsS "http://${HEALTH_HOST}:3000/healthz" >/dev/null 2>&1; then
    HEALTH_OK=1
    break
  fi
  sleep 2
done
if [ "$HEALTH_OK" -ne 1 ]; then
  echo "ERROR: 内网健康检查失败: http://${HEALTH_HOST}:3000/healthz" >&2
  docker compose logs --tail=30 jxc >&2 || true
  exit 1
fi
echo "内网健康检查通过: $(curl -fsS "http://${HEALTH_HOST}:3000/healthz")"

docker compose ps

for db in $(sudo find "${REMOTE_DIR}/data" -maxdepth 2 -name "*.db" | sort); do
  rel="${db#${REMOTE_DIR}/data/}"
  res="$(docker compose exec -T jxc node -e "const D=require('better-sqlite3'); console.log(new D(process.argv[1]).pragma('integrity_check', {simple:true}));" "/app/data/${rel}")"
  echo "PRAGMA integrity_check ${rel}: ${res}"
  if [ "$res" != "ok" ]; then
    echo "ERROR: 数据库完整性校验失败: ${rel} (${res})" >&2
    exit 1
  fi
done
REMOTE_EOF

echo "==> [2/2] 验收公网反代入口: ${PUBLIC_HEALTHZ_URL}..."
PUBLIC_BODY=""
for _ in $(seq 1 10); do
  if PUBLIC_BODY="$(curl -fsS "$PUBLIC_HEALTHZ_URL" 2>/dev/null)"; then
    break
  fi
  sleep 2
done
if ! printf '%s' "$PUBLIC_BODY" | grep -q '"ok"'; then
  echo "ERROR: 公网反代验收失败: ${PUBLIC_HEALTHZ_URL} -> '${PUBLIC_BODY}'" >&2
  exit 1
fi
echo "公网反代验收通过: ${PUBLIC_HEALTHZ_URL} -> ${PUBLIC_BODY}"
