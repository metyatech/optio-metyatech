#Requires -Version 7.0
param(
  [Alias('q')]
  [switch] $Quick,
  [switch] $NoPull
)

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
  if (-not $NoPull) {
    Require-Command 'git' 'Install Git or rerun with -NoPull.'
  }

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

Write-Host '=== Optio Local Update ==='
Write-Host ''

Write-Host '[1/7] Checking prerequisites, k3d cluster, and ingress-nginx...'
Check-Prerequisites
Ensure-K3dCluster
Ensure-IngressNginx

if (-not $NoPull) {
  Write-Host '[2/7] Pulling latest code...'
  git pull --rebase
  Assert-LastExitCode 'git pull --rebase failed.'
} else {
  Write-Host '[2/7] Skipping git pull'
}

Write-Host '[3/7] Installing dependencies...'
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
  pnpm install
  Assert-LastExitCode 'pnpm install failed.'
}

Write-Host '[4/7] Building images...'
docker build -t optio-api:latest -f Dockerfile.api . -q
Assert-LastExitCode 'API image build failed.'
docker build -t optio-web:latest -f Dockerfile.web . -q
Assert-LastExitCode 'Web image build failed.'

if (-not $Quick) {
  $rebuildAgents = $false
  foreach ($preset in @('base', 'node', 'python', 'go', 'rust', 'full')) {
    docker image inspect "optio-${preset}:latest" 1>$null 2>$null
    if ($LASTEXITCODE -ne 0) {
      $rebuildAgents = $true
      break
    }
  }

  if ($rebuildAgents) {
    Write-Host '   Rebuilding agent images (new presets detected)...'
    docker build -t optio-base:latest -f images/base.Dockerfile . -q
    Assert-LastExitCode 'Base agent image build failed.'
    docker tag optio-base:latest optio-agent:latest
    Assert-LastExitCode 'Failed to tag optio-agent image.'
    docker build -t optio-node:latest -f images/node.Dockerfile . -q
    Assert-LastExitCode 'Node agent image build failed.'
    docker build -t optio-python:latest -f images/python.Dockerfile . -q
    Assert-LastExitCode 'Python agent image build failed.'
    docker build -t optio-go:latest -f images/go.Dockerfile . -q
    Assert-LastExitCode 'Go agent image build failed.'
    docker build -t optio-rust:latest -f images/rust.Dockerfile . -q
    Assert-LastExitCode 'Rust agent image build failed.'
    docker build -t optio-full:latest -f images/full.Dockerfile . -q
    Assert-LastExitCode 'Full agent image build failed.'
  }

  docker image inspect 'optio-optio:latest' 1>$null 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-Host '   Rebuilding optio-optio (operations assistant)...'
    docker build -t optio-optio:latest -f Dockerfile.optio . -q
    Assert-LastExitCode 'Optio operations assistant image build failed.'
  }
}
Write-Host '   Images built.'

Write-Host '[5/7] Importing local images into k3d...'
Import-LocalImages

Write-Host '[6/7] Deploying Helm changes and restarting deployments...'
helm status optio -n optio 1>$null 2>$null
if ($LASTEXITCODE -eq 0) {
  helm upgrade optio helm/optio -n optio -f helm/optio/values.local.yaml --reset-then-reuse-values --wait --timeout=120s
  Assert-LastExitCode 'Helm upgrade failed.'
} else {
  $EncryptionKey = New-HexKey
  helm install optio helm/optio -n optio --create-namespace -f helm/optio/values.local.yaml --set "encryption.key=$EncryptionKey" --wait --timeout=120s
  Assert-LastExitCode 'Helm install failed.'
}

$deployments = @('deployment/optio-api', 'deployment/optio-web')
kubectl get deployment optio-optio -n optio 1>$null 2>$null
if ($LASTEXITCODE -eq 0) {
  $deployments += 'deployment/optio-optio'
}
kubectl rollout restart @deployments -n optio
Assert-LastExitCode 'Failed to restart Optio deployments.'

foreach ($deployment in $deployments) {
  kubectl rollout status $deployment -n optio --timeout=90s 1>$null 2>$null
}

Write-Host '[7/7] Verifying HTTP health through ingress...'
$Health = if (Test-HttpHealth $HealthUrl) { 'healthy' } else { 'not responding (may still be starting)' }

Write-Host ''
Write-Host '=== Update Complete ==='
Write-Host ''
Write-Host '  Web UI ...... http://localhost'
Write-Host "  API health .. $HealthUrl ($Health)"
if ($Quick) {
  Write-Host ''
  Write-Host '  (-Quick mode: agent images were not rebuilt)'
}
