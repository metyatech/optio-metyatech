#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

QUICK=false
SKIP_PULL=false
K3D_CLUSTER=""
INGRESS_NAMESPACE="ingress-nginx"
HEALTH_URL="http://localhost/api/health"
K3S_IMAGE="${OPTIO_K3S_IMAGE:-rancher/k3s:v1.34.1-k3s1}"

LOCAL_IMAGES=(
  optio-api:latest
  optio-web:latest
  optio-optio:latest
  optio-base:latest
  optio-agent:latest
  optio-node:latest
  optio-python:latest
  optio-go:latest
  optio-rust:latest
  optio-full:latest
)

usage() {
  echo "Usage: update-local.sh [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --quick, -q    Skip agent image rebuilds (api + web only)"
  echo "  --no-pull      Skip git pull"
  echo "  --help, -h     Show this help"
}

fail() {
  echo "❌ $1" >&2
  exit 1
}

require_command() {
  local name="$1"
  local hint="$2"

  command -v "$name" >/dev/null 2>&1 || fail "$name is required. $hint"
}

k3d_cluster_exists() {
  local name="$1"

  k3d cluster list "$name" -o json 2>/dev/null | grep -Eq '"name"[[:space:]]*:[[:space:]]*"'"$name"'"'
}

select_k3d_cluster() {
  if [ -n "${OPTIO_K3D_CLUSTER:-}" ]; then
    K3D_CLUSTER="$OPTIO_K3D_CLUSTER"
    return
  fi

  if k3d_cluster_exists optio-local; then
    K3D_CLUSTER="optio-local"
  elif k3d_cluster_exists optio-dev; then
    K3D_CLUSTER="optio-dev"
  else
    K3D_CLUSTER="optio-local"
  fi
}

check_prerequisites() {
  require_command docker "Install Docker Desktop or another Docker engine."
  require_command kubectl "Install kubectl and ensure it is on PATH."
  require_command helm "Install Helm and ensure it is on PATH."
  require_command k3d "Install k3d: https://k3d.io/"
  require_command pnpm "Install with: npm install -g pnpm"

  docker info >/dev/null 2>&1 || fail "Docker is not running. Start Docker Desktop or your Docker engine."
}

ensure_k3d_cluster() {
  select_k3d_cluster

  if k3d_cluster_exists "$K3D_CLUSTER"; then
    echo "   Using existing k3d cluster: $K3D_CLUSTER"
  else
    echo "   Creating k3d cluster: $K3D_CLUSTER"
    k3d cluster create "$K3D_CLUSTER" \
      --agents 1 \
      --image "$K3S_IMAGE" \
      --port "80:80@loadbalancer" \
      --k3s-arg "--disable=traefik@server:*" \
      --wait
  fi

  kubectl config use-context "k3d-$K3D_CLUSTER" >/dev/null
  kubectl cluster-info >/dev/null
}

disable_bundled_traefik() {
  if kubectl get deployment traefik -n kube-system >/dev/null 2>&1 || kubectl get helmchart traefik -n kube-system >/dev/null 2>&1; then
    echo "   Removing bundled Traefik from the local k3d cluster..."
    kubectl delete helmchart traefik -n kube-system >/dev/null 2>&1 || true
    kubectl delete helmchartconfig traefik -n kube-system >/dev/null 2>&1 || true
    kubectl delete deployment traefik -n kube-system >/dev/null 2>&1 || true
    kubectl delete service traefik -n kube-system >/dev/null 2>&1 || true
  fi
}

ensure_ingress_nginx() {
  disable_bundled_traefik

  if ! helm repo list 2>/dev/null | grep -q '^ingress-nginx[[:space:]]'; then
    helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
  fi
  helm repo update ingress-nginx

  helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    -n "$INGRESS_NAMESPACE" --create-namespace \
    --set controller.ingressClassResource.enabled=true \
    --set controller.ingressClassResource.name=nginx \
    --set controller.ingressClass=nginx \
    --set controller.watchIngressWithoutClass=false \
    --set controller.service.type=LoadBalancer \
    --set controller.allowSnippetAnnotations=true \
    --set controller.config.annotations-risk-level=Critical \
    --wait --timeout=180s

  kubectl rollout status deployment/ingress-nginx-controller -n "$INGRESS_NAMESPACE" --timeout=120s
}

import_local_images() {
  local existing_images=()

  for image in "${LOCAL_IMAGES[@]}"; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      existing_images+=("$image")
    fi
  done

  if [ "${#existing_images[@]}" -eq 0 ]; then
    fail "No Optio images were found to import into k3d."
  fi

  k3d image import "${existing_images[@]}" -c "$K3D_CLUSTER"
}

wait_for_http_health() {
  local attempt

  if ! command -v curl >/dev/null 2>&1; then
    echo "   curl not found; skipping HTTP health probe for $HEALTH_URL"
    return 1
  fi

  for attempt in $(seq 1 30); do
    if curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quick|-q) QUICK=true; shift ;;
    --no-pull) SKIP_PULL=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

echo "=== Optio Local Update ==="
echo ""

echo "[1/7] Checking prerequisites, k3d cluster, and ingress-nginx..."
check_prerequisites
ensure_k3d_cluster
ensure_ingress_nginx

if [ "$SKIP_PULL" = false ]; then
  echo "[2/7] Pulling latest code..."
  git pull --rebase
else
  echo "[2/7] Skipping git pull"
fi

echo "[3/7] Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "[4/7] Building images..."
docker build -t optio-api:latest -f Dockerfile.api . -q &
API_PID=$!
docker build -t optio-web:latest -f Dockerfile.web . -q &
WEB_PID=$!

if [ "$QUICK" = false ]; then
  REBUILD_AGENTS=false
  for preset in base node python go rust full; do
    if ! docker image inspect "optio-${preset}:latest" >/dev/null 2>&1; then
      REBUILD_AGENTS=true
      break
    fi
  done

  if [ "$REBUILD_AGENTS" = true ]; then
    echo "   Rebuilding agent images (new presets detected)..."
    docker build -t optio-base:latest -f images/base.Dockerfile . -q
    docker tag optio-base:latest optio-agent:latest
    docker build -t optio-node:latest -f images/node.Dockerfile . -q &
    NODE_PID=$!
    docker build -t optio-python:latest -f images/python.Dockerfile . -q &
    PYTHON_PID=$!
    docker build -t optio-go:latest -f images/go.Dockerfile . -q &
    GO_PID=$!
    docker build -t optio-rust:latest -f images/rust.Dockerfile . -q &
    RUST_PID=$!
    wait "$NODE_PID" || fail "Node agent image build failed"
    wait "$PYTHON_PID" || fail "Python agent image build failed"
    wait "$GO_PID" || fail "Go agent image build failed"
    wait "$RUST_PID" || fail "Rust agent image build failed"
    docker build -t optio-full:latest -f images/full.Dockerfile . -q
  fi

  if ! docker image inspect "optio-optio:latest" >/dev/null 2>&1; then
    echo "   Rebuilding optio-optio (operations assistant)..."
    docker build -t optio-optio:latest -f Dockerfile.optio . -q
  fi
fi

wait "$API_PID" || fail "API image build failed"
wait "$WEB_PID" || fail "Web image build failed"
echo "   Images built."

echo "[5/7] Importing local images into k3d..."
import_local_images

echo "[6/7] Deploying Helm changes and restarting deployments..."
if helm status optio -n optio >/dev/null 2>&1; then
  helm upgrade optio helm/optio -n optio \
    -f helm/optio/values.local.yaml \
    --reset-then-reuse-values \
    --wait --timeout=120s
else
  ENCRYPTION_KEY="$(openssl rand -hex 32)"
  helm install optio helm/optio -n optio --create-namespace \
    -f helm/optio/values.local.yaml \
    --set encryption.key="$ENCRYPTION_KEY" \
    --wait --timeout=120s
fi

DEPLOYMENTS="deployment/optio-api deployment/optio-web"
if kubectl get deployment optio-optio -n optio >/dev/null 2>&1; then
  DEPLOYMENTS="$DEPLOYMENTS deployment/optio-optio"
fi
kubectl rollout restart $DEPLOYMENTS -n optio

for dep in $DEPLOYMENTS; do
  kubectl rollout status "$dep" -n optio --timeout=90s >/dev/null 2>&1 || true
done

echo "[7/7] Verifying HTTP health through ingress..."
if wait_for_http_health; then
  HEALTH="healthy"
else
  HEALTH="not responding (may still be starting)"
fi

echo ""
echo "=== Update Complete ==="
echo ""
echo "  Web UI ...... http://localhost"
echo "  API health .. $HEALTH_URL ($HEALTH)"
if [ "$QUICK" = true ]; then
  echo ""
  echo "  (--quick mode: agent images were not rebuilt)"
fi
