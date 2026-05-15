#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $PSCommandPath
$RootDir = Resolve-Path -LiteralPath (Join-Path $ScriptDir '..')
Set-Location -LiteralPath $RootDir

$K3dCluster = ''
$IngressNamespace = 'ingress-nginx'
$HealthUrl = 'http://localhost/api/health'
$K3sImage = if ([string]::IsNullOrWhiteSpace($env:OPTIO_K3S_IMAGE)) { 'rancher/k3s:v1.34.1-k3s1' } else { $env:OPTIO_K3S_IMAGE }
$LocalImages = @(
  'optio-api:latest',
  'optio-web:latest',
  'optio-optio:latest',
  'optio-base:latest',
  'optio-agent:latest',
  'optio-node:latest',
  'optio-python:latest',
  'optio-go:latest',
  'optio-rust:latest',
  'optio-full:latest'
)

function Assert-LastExitCode {
  param([string] $Message)

  if ($LASTEXITCODE -ne 0) {
    throw $Message
  }
}

function Require-Command {
  param(
    [string] $Name,
    [string] $Hint
  )

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. $Hint"
  }
}

function Test-K3dCluster {
  param([string] $Name)

  $clusterOutput = k3d cluster list $Name -o json 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($clusterOutput)) {
    return $false
  }

  $clusters = @($clusterOutput | ConvertFrom-Json)
  return @($clusters | Where-Object { $_.name -eq $Name }).Count -gt 0
}

function Select-K3dCluster {
  if (-not [string]::IsNullOrWhiteSpace($env:OPTIO_K3D_CLUSTER)) {
    return $env:OPTIO_K3D_CLUSTER
  }

  if (Test-K3dCluster 'optio-local') {
    return 'optio-local'
  }
  if (Test-K3dCluster 'optio-dev') {
    return 'optio-dev'
  }
  return 'optio-local'
}

function Check-Prerequisites {
  Require-Command 'docker' 'Install Docker Desktop or another Docker engine.'
  Require-Command 'kubectl' 'Install kubectl and ensure it is on PATH.'
  Require-Command 'helm' 'Install Helm and ensure it is on PATH.'
  Require-Command 'k3d' 'Install k3d: https://k3d.io/'
  Require-Command 'pnpm' 'Install with: npm install -g pnpm'

  docker info 1>$null 2>$null
  Assert-LastExitCode 'Docker is not running. Start Docker Desktop or your Docker engine.'
}

function Ensure-K3dCluster {
  $script:K3dCluster = Select-K3dCluster

  if (Test-K3dCluster $script:K3dCluster) {
    Write-Host "   Using existing k3d cluster: $script:K3dCluster"
  } else {
    Write-Host "   Creating k3d cluster: $script:K3dCluster"
    $createArgs = @(
      'cluster', 'create', $script:K3dCluster,
      '--agents', '1',
      '--image', $K3sImage,
      '--port', '80:80@loadbalancer',
      '--k3s-arg', '--disable=traefik@server:*',
      '--wait'
    )
    k3d @createArgs
    Assert-LastExitCode "Failed to create k3d cluster $script:K3dCluster."
  }

  kubectl config use-context "k3d-$script:K3dCluster" 1>$null
  Assert-LastExitCode "Failed to select kubectl context k3d-$script:K3dCluster."
  kubectl cluster-info 1>$null
  Assert-LastExitCode 'kubectl cannot reach the selected k3d cluster.'
}

function Warn-IfOldKubernetes {
  $versionJson = kubectl version --output=json 2>$null
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($versionJson)) {
    return
  }

  $version = $versionJson | ConvertFrom-Json
  $gitVersion = $version.serverVersion.gitVersion
  if ($gitVersion -match '^v(?<major>\d+)\.(?<minor>\d+)') {
    $major = [int] $Matches.major
    $minor = [int] $Matches.minor
    if ($major -lt 1 -or ($major -eq 1 -and $minor -lt 33)) {
      Write-Host "⚠ WARNING: Kubernetes $gitVersion detected. Optio recommends v1.33+ for"
      Write-Host '  post-quantum TLS on the control plane. v1.33 is the first release built on'
      Write-Host '  Go 1.24, which enables hybrid X25519MLKEM768 key exchange automatically.'
      Write-Host ''
    }
  }
}

function Disable-BundledTraefik {
  kubectl get deployment traefik -n kube-system 1>$null 2>$null
  $hasDeployment = $LASTEXITCODE -eq 0
  kubectl get helmchart traefik -n kube-system 1>$null 2>$null
  $hasHelmChart = $LASTEXITCODE -eq 0

  if ($hasDeployment -or $hasHelmChart) {
    Write-Host '   Removing bundled Traefik from the local k3d cluster...'
    kubectl delete helmchart traefik -n kube-system 1>$null 2>$null
    kubectl delete helmchartconfig traefik -n kube-system 1>$null 2>$null
    kubectl delete deployment traefik -n kube-system 1>$null 2>$null
    kubectl delete service traefik -n kube-system 1>$null 2>$null
  }
}

function Ensure-IngressNginx {
  Disable-BundledTraefik

  $repoOutput = helm repo list -o json 2>$null
  $repoNames = @()
  if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($repoOutput)) {
    $repoNames = @($repoOutput | ConvertFrom-Json | ForEach-Object { $_.name })
  }
  if ($repoNames -notcontains 'ingress-nginx') {
    helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
    Assert-LastExitCode 'Failed to add ingress-nginx Helm repository.'
  }
  helm repo update ingress-nginx
  Assert-LastExitCode 'Failed to update ingress-nginx Helm repository.'

  $helmArgs = @(
    'upgrade', '--install', 'ingress-nginx', 'ingress-nginx/ingress-nginx',
    '-n', $IngressNamespace, '--create-namespace',
    '--set', 'controller.ingressClassResource.enabled=true',
    '--set', 'controller.ingressClassResource.name=nginx',
    '--set', 'controller.ingressClass=nginx',
    '--set', 'controller.watchIngressWithoutClass=false',
    '--set', 'controller.service.type=LoadBalancer',
    '--set', 'controller.allowSnippetAnnotations=true',
    '--set', 'controller.config.annotations-risk-level=Critical',
    '--wait', '--timeout=180s'
  )
  helm @helmArgs
  Assert-LastExitCode 'Failed to install or update ingress-nginx.'

  kubectl rollout status deployment/ingress-nginx-controller -n $IngressNamespace --timeout=120s
  Assert-LastExitCode 'ingress-nginx controller did not become ready.'
}

function Import-LocalImages {
  $existingImages = @()
  foreach ($image in $LocalImages) {
    docker image inspect $image 1>$null 2>$null
    if ($LASTEXITCODE -eq 0) {
      $existingImages += $image
    }
  }

  if ($existingImages.Count -eq 0) {
    throw 'No Optio images were found to import into k3d.'
  }

  k3d image import @existingImages -c $script:K3dCluster
  Assert-LastExitCode 'Failed to import local images into k3d.'
}

function New-HexKey {
  $bytes = [byte[]]::new(32)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return -join ($bytes | ForEach-Object { $_.ToString('x2') })
}

function Test-HttpHealth {
  param([string] $Url)

  for ($attempt = 1; $attempt -le 30; $attempt += 1) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
      if ($response.StatusCode -eq 200) {
        return $true
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }

  return $false
}

Write-Host '=== Optio Local Setup ==='
Write-Host ''

Write-Host '[1/8] Checking prerequisites and local k3d cluster...'
Check-Prerequisites
Ensure-K3dCluster
Warn-IfOldKubernetes

Write-Host '[2/8] Installing dependencies...'
pnpm install
Assert-LastExitCode 'pnpm install failed.'

Write-Host '[3/8] Building agent images...'
Write-Host '   Building optio-base (required)...'
docker build -t optio-base:latest -f images/base.Dockerfile . -q
Assert-LastExitCode 'Base agent image build failed.'
docker tag optio-base:latest optio-agent:latest
Assert-LastExitCode 'Failed to tag optio-agent image.'
Write-Host '   Building optio-node...'
docker build -t optio-node:latest -f images/node.Dockerfile . -q
Assert-LastExitCode 'Node agent image build failed.'
Write-Host '   Building optio-python...'
docker build -t optio-python:latest -f images/python.Dockerfile . -q
Assert-LastExitCode 'Python agent image build failed.'
Write-Host '   Building optio-go...'
docker build -t optio-go:latest -f images/go.Dockerfile . -q
Assert-LastExitCode 'Go agent image build failed.'
Write-Host '   Building optio-rust...'
docker build -t optio-rust:latest -f images/rust.Dockerfile . -q
Assert-LastExitCode 'Rust agent image build failed.'
Write-Host '   Building optio-optio (operations assistant)...'
docker build -t optio-optio:latest -f Dockerfile.optio . -q
Assert-LastExitCode 'Optio operations assistant image build failed.'
Write-Host '   Building optio-full...'
docker build -t optio-full:latest -f images/full.Dockerfile . -q
Assert-LastExitCode 'Full agent image build failed.'
Write-Host '   All agent images built.'

Write-Host '[4/8] Building API and Web images...'
docker build -t optio-api:latest -f Dockerfile.api . -q
Assert-LastExitCode 'API image build failed.'
docker build -t optio-web:latest -f Dockerfile.web . -q
Assert-LastExitCode 'Web image build failed.'
Write-Host '   API and Web images built.'

Write-Host '[5/8] Importing local images into k3d...'
Import-LocalImages

Write-Host '[6/8] Installing ingress-nginx and metrics-server...'
Ensure-IngressNginx
kubectl get deployment metrics-server -n kube-system 1>$null 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host '   metrics-server already installed, skipping'
} else {
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host '   ⚠ Failed to install metrics-server (resource utilization will show N/A)'
  }
  kubectl patch deployment metrics-server -n kube-system --type=json -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' 1>$null 2>$null
  Write-Host '   metrics-server installed (may take a minute to become ready)'
}

Write-Host '[7/8] Deploying Optio to Kubernetes via Helm...'
$EncryptionKey = New-HexKey
helm status optio -n optio 1>$null 2>$null
if ($LASTEXITCODE -eq 0) {
  Write-Host '   Existing release found, upgrading...'
  helm upgrade optio helm/optio -n optio -f helm/optio/values.local.yaml --set "encryption.key=$EncryptionKey" --wait --timeout=120s
  Assert-LastExitCode 'Helm upgrade failed.'
} else {
  helm install optio helm/optio -n optio --create-namespace -f helm/optio/values.local.yaml --set "encryption.key=$EncryptionKey" --wait --timeout=120s
  Assert-LastExitCode 'Helm install failed.'
}
Write-Host '   Helm deployment complete.'

Write-Host '[8/8] Verifying deployment...'
kubectl wait --namespace optio --for=condition=available deployment/optio-api --timeout=60s 1>$null 2>$null
kubectl wait --namespace optio --for=condition=available deployment/optio-web --timeout=60s 1>$null 2>$null
kubectl wait --namespace optio --for=condition=available deployment/optio-optio --timeout=60s 1>$null 2>$null

$Health = if (Test-HttpHealth $HealthUrl) { 'healthy' } else { 'not responding (may still be starting)' }

Write-Host ''
Write-Host '=== Setup Complete ==='
Write-Host ''
Write-Host 'Services:'
Write-Host '  Web UI ...... http://localhost'
Write-Host "  API health .. $HealthUrl ($Health)"
Write-Host '  Postgres .... optio-postgres:5432 (K8s internal)'
Write-Host '  Redis ....... optio-redis:6379 (K8s internal)'
Write-Host ''
Write-Host 'Agent images:'
docker images --filter 'reference=optio-*' --format '  {{.Repository}}:{{.Tag}}'
Write-Host ''
Write-Host 'Next steps:'
Write-Host ''
Write-Host '  1. Open the setup wizard:'
Write-Host '     http://localhost/setup'
Write-Host ''
Write-Host '  2. After rebuilding images, redeploy with:'
Write-Host '     .\scripts\update-local.ps1 -Quick'
Write-Host ''
Write-Host 'To tear down:'
Write-Host '  helm uninstall optio -n optio'
Write-Host "  k3d cluster delete $K3dCluster"
