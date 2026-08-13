#!/usr/bin/env bash
# Recover from Caddy 502 / partial stack after deploy on the VM.
# Run on the VM (or via gcloud compute ssh ... --command="sudo bash -s" < scripts/fix-gcloud-vm.sh)
#
# From your laptop:
#   gcloud compute ssh commercialbrainz-vm --zone=us-central1-b \
#     --command='sudo bash /opt/commercialbrainz/scripts/fix-gcloud-vm.sh'
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/commercialbrainz}"
APP_BRANCH="${APP_BRANCH:-testing}"
# Legacy branch names.
if [[ "$APP_BRANCH" == "main" || "$APP_BRANCH" == "google" ]]; then
  echo "WARN: APP_BRANCH=${APP_BRANCH} is retired; using testing"
  APP_BRANCH=testing
elif [[ "$APP_BRANCH" == "cloudflare" ]]; then
  echo "WARN: APP_BRANCH=cloudflare is retired; using public"
  APP_BRANCH=public
fi
cd "$APP_DIR"

# Narrow env for compose interpolation (IMAGE_TAG/GHCR_OWNER/DOMAIN/ACME_EMAIL).
# Prevents Compose from expanding "$" inside secrets in .env.
write_compose_env() {
  bash "$APP_DIR/infra/gcloud/write-compose-env.sh" "$APP_DIR"
}
write_compose_env

if [[ "$(id -u)" -eq 0 ]]; then
  # --project-directory infra avoids loading repo-root .env for Compose
  # interpolation (secrets with "$" caused "G" / "mcpX" variable warnings).
  COMPOSE="docker compose --project-directory infra --env-file infra/compose.env -f infra/docker-compose.yml -f infra/docker-compose.vm.yml"
else
  COMPOSE="sudo docker compose --project-directory infra --env-file infra/compose.env -f infra/docker-compose.yml -f infra/docker-compose.vm.yml"
fi

# Sync first, then re-exec so the remainder of this run uses the new script
# inode (bash keeps reading the old file after `git reset` replaces it).
if [[ "${CB_REPO_SYNCED:-}" != "1" ]]; then
  echo "==> Sync to origin/${APP_BRANCH} (discard local tracked changes; keep .env)"
  run_git() {
    if [[ "$(id -u)" -eq 0 ]]; then
      "$@"
    else
      sudo "$@"
    fi
  }
  run_git git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
  # Heal single-branch clones left over from the deleted main branch.
  run_git git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*' || true
  run_git git fetch origin "refs/heads/${APP_BRANCH}:refs/remotes/origin/${APP_BRANCH}"
  if run_git git rev-parse --verify "origin/${APP_BRANCH}" >/dev/null 2>&1; then
    run_git git checkout -B "$APP_BRANCH" "origin/${APP_BRANCH}"
    run_git git reset --hard "origin/${APP_BRANCH}"
  else
    run_git git checkout -B "$APP_BRANCH" FETCH_HEAD
    run_git git reset --hard FETCH_HEAD
  fi
  run_git git clean -fd -e .env -e infra/caddy/Caddyfile.runtime -e infra/compose.env -e data/maintenance -e data/caddy
  run_git git rev-parse --short HEAD
  export CB_REPO_SYNCED=1
  echo "==> Re-executing deploy script from synced tree"
  if [[ "$(id -u)" -eq 0 ]]; then
    exec env CB_REPO_SYNCED=1 IMAGE_TAG="${IMAGE_TAG:-}" APP_BRANCH="${APP_BRANCH}" bash "$APP_DIR/scripts/fix-gcloud-vm.sh"
  else
    exec sudo env CB_REPO_SYNCED=1 IMAGE_TAG="${IMAGE_TAG:-}" APP_BRANCH="${APP_BRANCH}" \
      bash "$APP_DIR/scripts/fix-gcloud-vm.sh"
  fi
fi

echo "==> Full stack status"
write_compose_env
$COMPOSE ps -a

echo ""
echo "==> Apply site env for branch ${APP_BRANCH}"
# testing → https://commercialbrainz.duckdns.org/  (Let's Encrypt)
# public    → https://commercialbrainz.org/       (Cloudflare Origin CA)
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    if [[ "$(id -u)" -eq 0 ]]; then
      sed -i "s|^${key}=.*|${key}=${value}|" .env
    else
      sudo sed -i "s|^${key}=.*|${key}=${value}|" .env
    fi
  else
    if [[ "$(id -u)" -eq 0 ]]; then
      echo "${key}=${value}" >> .env
    else
      echo "${key}=${value}" | sudo tee -a .env >/dev/null
    fi
  fi
}

ACME_EMAIL="$(grep '^ACME_EMAIL=' .env 2>/dev/null | cut -d= -f2- || true)"
ACME_EMAIL="${ACME_EMAIL:-commercialbrainz@outlook.com}"

if [[ "$APP_BRANCH" == "public" ]]; then
  set_env DOMAIN "commercialbrainz.org"
  set_env DOMAIN_ALIASES "www.commercialbrainz.org"
  set_env CADDY_TLS_MODE "origin"
  set_env APP_PUBLIC_URL "https://commercialbrainz.org"
  set_env API_PUBLIC_URL "https://commercialbrainz.org"
  set_env CORS_ORIGINS "https://commercialbrainz.org,https://www.commercialbrainz.org"
  set_env ACME_EMAIL "$ACME_EMAIL"
  set_env PUBLIC_SITE "true"
  set_env APP_ENV "production"
  echo "    Public site: https://commercialbrainz.org/ (Origin CA on commercialbrainz-public)"
elif [[ "$APP_BRANCH" == "testing" ]]; then
  set_env DOMAIN "commercialbrainz.duckdns.org"
  set_env DOMAIN_ALIASES ""
  set_env CADDY_TLS_MODE "auto"
  set_env APP_PUBLIC_URL "https://commercialbrainz.duckdns.org"
  set_env API_PUBLIC_URL "https://commercialbrainz.duckdns.org"
  set_env CORS_ORIGINS "https://commercialbrainz.duckdns.org"
  set_env ACME_EMAIL "$ACME_EMAIL"
  set_env PUBLIC_SITE "false"
  set_env APP_ENV "testing"
  echo "    Testing site: https://commercialbrainz.duckdns.org/ (Let's Encrypt on commercialbrainz-vm)"
else
  echo "    WARN: unknown APP_BRANCH=${APP_BRANCH}; leaving DOMAIN settings in .env unchanged"
fi

echo ""
echo "==> Regenerate Caddyfile"
DOMAIN="$(grep '^DOMAIN=' .env 2>/dev/null | cut -d= -f2- || true)"
ACME_EMAIL="$(grep '^ACME_EMAIL=' .env 2>/dev/null | cut -d= -f2- || true)"
DOMAIN_ALIASES="$(grep '^DOMAIN_ALIASES=' .env 2>/dev/null | cut -d= -f2- || true)"
CADDY_TLS_MODE="$(grep '^CADDY_TLS_MODE=' .env 2>/dev/null | cut -d= -f2- || true)"
CADDY_TLS_MODE="${CADDY_TLS_MODE:-auto}"
mkdir -p data/caddy/certs
# Public site wants Origin CA, but Caddy crash-loops if the files are missing.
# Fall back to HTTP-only until scripts/setup-cloudflare-domain.sh installs them.
if [[ "$CADDY_TLS_MODE" == "origin" ]]; then
  if [[ ! -s data/caddy/certs/origin.crt || ! -s data/caddy/certs/origin.key ]]; then
    echo "WARN: Origin CA not found at data/caddy/certs/origin.{crt,key}"
    echo "      Generating HTTP-only Caddyfile so the stack can start."
    echo "      Next: create Cloudflare Origin CA cert, then run:"
    echo "        GCP_PROJECT_ID=commercialbrainz-public \\"
    echo "        ORIGIN_CERT=/path/to/origin.crt ORIGIN_KEY=/path/to/origin.key \\"
    echo "          ./scripts/setup-cloudflare-domain.sh"
    CADDY_TLS_MODE="http"
  fi
fi
bash infra/gcloud/generate-caddyfile.sh \
  infra/caddy/Caddyfile.runtime \
  "${DOMAIN}" \
  "${ACME_EMAIL}" \
  "${DOMAIN_ALIASES}" \
  "${CADDY_TLS_MODE}"
write_compose_env

echo ""
# Prefer images prebuilt+pushed by GitHub Actions (GHCR). Fall back to on-VM
# build only if pull fails (e.g. first boot before packages exist / private).
# IMAGE_TAG from the caller wins; otherwise .env / latest.
_DEPLOY_IMAGE_TAG="${IMAGE_TAG:-}"
if [[ -f .env ]]; then
  _env_val() { grep -E "^${1}=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
  : "${GHCR_TOKEN:=$(_env_val GHCR_TOKEN)}"
  : "${GHCR_USER:=$(_env_val GHCR_USER)}"
  : "${_DEPLOY_IMAGE_TAG:=$(_env_val IMAGE_TAG)}"
fi
export IMAGE_TAG="${_DEPLOY_IMAGE_TAG:-latest}"
export DOMAIN ACME_EMAIL
echo "==> App images IMAGE_TAG=${IMAGE_TAG}"
write_compose_env

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  echo "==> docker login ghcr.io"
  # Root and non-root compose paths both need credentials in the docker config
  # used by the daemon client (`sudo docker` when not root).
  if [[ "$(id -u)" -eq 0 ]]; then
    echo "${GHCR_TOKEN}" | docker login ghcr.io \
      -u "${GHCR_USER:-binarygeek119}" --password-stdin
  else
    echo "${GHCR_TOKEN}" | sudo docker login ghcr.io \
      -u "${GHCR_USER:-binarygeek119}" --password-stdin
  fi
fi

MAINT_FLAGS_DIR="${APP_DIR}/data/maintenance"
mkdir -p "$MAINT_FLAGS_DIR"
MAINT_FLAG="${MAINT_FLAGS_DIR}/UPDATE_IN_PROGRESS"

echo "==> Pull prebuilt images from GHCR"
# Prefer explicit docker pull so failures are obvious (compose may mask them).
GHCR_OWNER="${GHCR_OWNER:-commercialbrainz}"
API_IMAGE="ghcr.io/${GHCR_OWNER}/commercialbrainz-api:${IMAGE_TAG}"
WEB_IMAGE="ghcr.io/${GHCR_OWNER}/commercialbrainz-web:${IMAGE_TAG}"
MAINT_IMAGE="ghcr.io/${GHCR_OWNER}/commercialbrainz-maintenance:${IMAGE_TAG}"
if [[ "$(id -u)" -eq 0 ]]; then DOCKER=docker; else DOCKER="sudo docker"; fi

echo "==> Free disk space (unused Docker images/cache; keeps named volumes)"
df -h / 2>/dev/null | tail -1 || true
$DOCKER builder prune -af >/dev/null 2>&1 || true
$DOCKER image prune -af >/dev/null 2>&1 || true
$DOCKER container prune -f >/dev/null 2>&1 || true
$DOCKER system prune -af >/dev/null 2>&1 || true
df -h / 2>/dev/null | tail -1 || true
$DOCKER system df 2>/dev/null || true

echo "==> Enable maintenance gate (UPDATE_IN_PROGRESS)"
touch "$MAINT_FLAG"

clear_maint_flag() {
  rm -f "$MAINT_FLAG" || true
}
trap clear_maint_flag EXIT

if $DOCKER pull "$API_IMAGE" && $DOCKER pull "$WEB_IMAGE" && $DOCKER pull "$MAINT_IMAGE"; then
  echo "==> Starting stack from pulled images (no on-VM build)"
  $COMPOSE up -d postgres redis
  # Bring maintenance up first so Caddy forward_auth can serve the update page
  # while api/web are recreated.
  $COMPOSE up -d --pull missing --force-recreate --no-build maintenance
  echo "==> Waiting for maintenance gate..."
  for i in $(seq 1 30); do
    if $COMPOSE exec -T maintenance \
      wget -q -O /dev/null http://127.0.0.1:8080/_maintenance/alive 2>/dev/null; then
      echo "Maintenance gate healthy"
      break
    fi
    if [[ $i -eq 30 ]]; then
      echo "ERROR: maintenance did not become healthy"
      $COMPOSE logs maintenance --tail=40
      exit 1
    fi
    sleep 2
  done
  $COMPOSE up -d --pull missing --force-recreate --no-build --no-deps caddy
  # Caddy can take a few seconds after recreate before :80 answers.
  for i in $(seq 1 20); do
    if curl -s -o /dev/null -w '' --max-time 2 http://127.0.0.1/ >/dev/null 2>&1 \
      || curl -s -o /dev/null -w '' --max-time 2 http://127.0.0.1/health >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  sleep 2
  echo "==> Expect maintenance page while flag is set"
  _code="$(curl -s -o /tmp/cb-maint.html -w '%{http_code}' --max-time 5 http://127.0.0.1/ || true)"
  echo "GET / -> HTTP ${_code}"
  if [[ "${_code}" != "503" ]]; then
    echo "WARN: expected 503 maintenance page during update (got ${_code})"
    head -c 400 /tmp/cb-maint.html 2>/dev/null || true
    echo ""
  else
    grep -qi 'update\|maintenance\|come back' /tmp/cb-maint.html \
      && echo "OK: maintenance HTML served during update" \
      || echo "WARN: 503 without expected maintenance copy"
  fi
  $COMPOSE up -d --pull missing --force-recreate --no-build api worker web
else
  echo "WARN: GHCR pull failed — falling back to on-VM compose build"
  $COMPOSE build api worker web maintenance
  $COMPOSE up -d postgres redis
  $COMPOSE up -d --force-recreate maintenance
  sleep 5
  $COMPOSE up -d --force-recreate --no-deps caddy
  sleep 3
  $COMPOSE up -d --force-recreate api worker web
fi

echo ""
echo "==> Waiting for API (migrations + uvicorn)..."
for i in $(seq 1 36); do
  if $COMPOSE exec -T api \
    python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')" 2>/dev/null; then
    echo "API healthy"
    break
  fi
  if [[ $i -eq 36 ]]; then
    echo "ERROR: API did not become healthy — check migrations:"
    $COMPOSE logs api --tail=60
    exit 1
  fi
  sleep 10
done

echo ""
echo "==> Clear maintenance gate"
clear_maint_flag
trap - EXIT

echo ""
echo "==> Recreate Caddy (refresh Docker DNS / forward_auth)"
$COMPOSE up -d --force-recreate --no-deps caddy
sleep 5

echo ""
echo "==> Container ages (web/caddy should match api after deploy)"
$COMPOSE ps -a --format 'table {{.Name}}\t{{.Status}}\t{{.RunningFor}}' api worker web maintenance caddy 2>/dev/null \
  || $COMPOSE ps api worker web maintenance caddy

echo ""
echo "==> Test login endpoint (expect 401 for bad password, not 503)"
curl -s -o /tmp/cb-login-test.json -w "HTTP %{http_code}\n" \
  -X POST http://127.0.0.1/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"__login_probe__","password":"wrong"}' || true
cat /tmp/cb-login-test.json 2>/dev/null || true

echo ""
echo "==> Verify database"
HEALTH="$(curl -sf http://127.0.0.1/health || true)"
echo "$HEALTH"
echo "$HEALTH" | grep -q '"database":"ok"' && echo "OK: database connected" || {
  echo "FAIL: database not connected — fixing .env and retrying migrations"
  grep -q '^DATABASE_URL=' .env && sed -i 's|^DATABASE_URL=.*|DATABASE_URL=postgresql+asyncpg://commercialbrainz:commercialbrainz@postgres:5432/commercialbrainz|' .env \
    || echo 'DATABASE_URL=postgresql+asyncpg://commercialbrainz:commercialbrainz@postgres:5432/commercialbrainz' >> .env
  grep -q '^DATABASE_URL_SYNC=' .env && sed -i 's|^DATABASE_URL_SYNC=.*|DATABASE_URL_SYNC=postgresql://commercialbrainz:commercialbrainz@postgres:5432/commercialbrainz|' .env \
    || echo 'DATABASE_URL_SYNC=postgresql://commercialbrainz:commercialbrainz@postgres:5432/commercialbrainz' >> .env
  grep -q '^REDIS_URL=' .env && sed -i 's|^REDIS_URL=.*|REDIS_URL=redis://redis:6379/0|' .env \
    || echo 'REDIS_URL=redis://redis:6379/0' >> .env
  $COMPOSE up -d --force-recreate api worker
  sleep 15
  curl -sf http://127.0.0.1/health || true
  $COMPOSE logs api --tail=40
}

echo ""
echo "==> Verify"
$COMPOSE ps
echo ""
curl -sf http://127.0.0.1/health && echo "OK: /health via Caddy" || {
  echo "FAIL: /health via Caddy"
  $COMPOSE logs caddy --tail=30
  exit 1
}
curl -sf -o /dev/null http://127.0.0.1/ && echo "OK: / web UI via Caddy" || {
  echo "FAIL: / web UI via Caddy"
  $COMPOSE logs web --tail=20
  $COMPOSE logs caddy --tail=20
  $COMPOSE logs maintenance --tail=20
  exit 1
}
# Confirm gate is open (auth 200) after flag cleared.
_auth="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/_maintenance/auth || true)"
echo "GET /_maintenance/auth -> HTTP ${_auth} (expect 200 when open)"

echo ""
echo "==> Done"
