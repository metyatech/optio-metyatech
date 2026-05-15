#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

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

warn_if_old_kubernetes() {
  local server_version
  local major
  local minor

  server_version="$(kubectl version --output=json 2>/dev/null | grep -oE '"gitVersion":[[:space:]]*"v[0-9]+\.[0-9]+' | tail -1 | grep -oE '[0-9]+\.[0-9]+' || true)"
  if [ -z "$server_version" ]; then
    return
  fi

  major="$(echo "$server_version" | cut -d. -f1)"
  minor="$(echo "$server_version" | cut -d. -f2)"
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 33 ]; }; then
    echo "⚠ WARNING: Kubernetes v${server_version} detected. Optio recommends v1.33+ for"
    echo "  post-quantum TLS on the control plane. v1.33 is the first release built on"
    echo "  Go 1.24, which enables hybrid X25519MLKEM768 key exchange automatically."
    echo ""
  fi
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

echo "=== Optio Local Setup ==="
echo ""

echo "[1/8] Checking prerequisites and local k3d cluster..."
check_prerequisites
ensure_k3d_cluster
warn_if_old_kubernetes

echo "[2/8] Installing dependencies..."
pnpm install

echo "[3/8] Building agent images..."
echo "   Building optio-base (required)..."
docker build -t optio-base:latest -f images/base.Dockerfile . -q
docker tag optio-base:latest optio-agent:latest
echo "   Building optio-node..."
docker build -t optio-node:latest -f images/node.Dockerfile . -q &
NODE_PID=$!
echo "   Building optio-python..."
docker build -t optio-python:latest -f images/python.Dockerfile . -q &
PYTHON_PID=$!
echo "   Building optio-go..."
docker build -t optio-go:latest -f images/go.Dockerfile . -q &
GO_PID=$!
echo "   Building optio-rust..."
docker build -t optio-rust:latest -f images/rust.Dockerfile . -q &
RUST_PID=$!
echo "   Building optio-optio (operations assistant)..."
docker build -t optio-optio:latest -f Dockerfile.optio . -q &
OPTIO_PID=$!
wait "$NODE_PID" || fail "Node agent image build failed"
wait "$PYTHON_PID" || fail "Python agent image build failed"
wait "$GO_PID" || fail "Go agent image build failed"
wait "$RUST_PID" || fail "Rust agent image build failed"
wait "$OPTIO_PID" || fail "Optio operations assistant image build failed"
echo "   Building optio-full..."
docker build -t optio-full:latest -f images/full.Dockerfile . -q
echo "   All agent images built."

echo "[4/8] Building API and Web images..."
docker build -t optio-api:latest -f Dockerfile.api . -q
docker build -t optio-web:latest -f Dockerfile.web . -q
echo "   API and Web images built."

echo "[5/8] Importing local images into k3d..."
import_local_images

echo "[6/8] Installing ingress-nginx and metrics-server..."
ensure_ingress_nginx
if kubectl get deployment metrics-server -n kube-system >/dev/null 2>&1; then
  echo "   metrics-server already installed, skipping"
else
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml >/dev/null 2>&1 || {
    echo "   ⚠ Failed to install metrics-server (resource utilization will show N/A)"
  }
  kubectl patch deployment metrics-server -n kube-system --type=json \
    -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null 2>&1 || true
  echo "   metrics-server installed (may take a minute to become ready)"
fi

echo "[7/8] Deploying Optio to Kubernetes via Helm..."
ENCRYPTION_KEY="$(openssl rand -hex 32)"

if helm status optio -n optio >/dev/null 2>&1; then
  echo "   Existing release found, upgrading..."
  helm upgrade optio helm/optio -n optio \
    -f helm/optio/values.local.yaml \
    --set encryption.key="$ENCRYPTION_KEY" \
    --wait --timeout=120s
else
  helm install optio helm/optio -n optio --create-namespace \
    -f helm/optio/values.local.yaml \
    --set encryption.key="$ENCRYPTION_KEY" \
    --wait --timeout=120s
fi
echo "   Helm deployment complete."

echo "[8/8] Verifying deployment..."
kubectl wait --namespace optio --for=condition=available deployment/optio-api --timeout=60s >/dev/null 2>&1 || true
kubectl wait --namespace optio --for=condition=available deployment/optio-web --timeout=60s >/dev/null 2>&1 || true
kubectl wait --namespace optio --for=condition=available deployment/optio-optio --timeout=60s >/dev/null 2>&1 || true

if wait_for_http_health; then
  HEALTH="healthy"
else
  HEALTH="not responding (may still be starting)"
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Services:"
echo "  Web UI ...... http://localhost"
echo "  API health .. $HEALTH_URL ($HEALTH)"
echo "  Postgres .... optio-postgres:5432 (K8s internal)"
echo "  Redis ....... optio-redis:6379 (K8s internal)"
echo ""
echo "Agent images:"
docker images --filter "reference=optio-*" --format "  {{.Repository}}:{{.Tag}}" 2>/dev/null || true
echo ""
echo "Next steps:"
echo ""
echo "  1. Open the setup wizard:"
echo "     http://localhost/setup"
echo ""
echo "  2. After rebuilding images, redeploy with:"
echo "     ./scripts/update-local.sh --quick"
echo ""
echo "To tear down:"
echo "  helm uninstall optio -n optio"
echo "  k3d cluster delete $K3D_CLUSTER"
