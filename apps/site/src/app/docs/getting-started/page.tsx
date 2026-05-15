import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Getting Started",
  description:
    "Get up and running with Optio in minutes. Clone the repo, run the setup script, and start orchestrating AI coding agents on Kubernetes.",
};

export default function GettingStartedPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Getting Started</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Optio is a workflow orchestration system for AI coding agents. Think of it as &quot;CI/CD
        where the build step is an AI agent.&quot; You submit tasks — from GitHub Issues, Linear,
        Jira, Notion, or manually — and Optio handles the full lifecycle: provisioning an isolated
        environment, running the agent, opening a PR, monitoring CI, handling code review, and
        merging when everything passes.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Quick Start</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        The fastest way to try Optio is with k3d on top of Docker Desktop or another Docker engine.
        The setup script handles everything: building images, installing dependencies, installing
        ingress-nginx, and deploying via Helm.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Prerequisites</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>Docker Desktop or another Docker engine</li>
        <li>k3d</li>
        <li>Node.js 22+</li>
        <li>pnpm 10+</li>
        <li>Helm 3+</li>
        <li>kubectl</li>
      </ul>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Setup</h3>
      <div className="mt-3">
        <CodeBlock title="terminal">{`git clone https://github.com/jonwiggins/optio.git
cd optio
./scripts/setup-local.sh`}</CodeBlock>
      </div>

      <p className="mt-4 text-text-muted leading-relaxed">
        The script creates or reuses a local k3d cluster, builds all container images (API, web,
        agent presets), imports them into k3d, installs the Helm chart, and starts the services.
        This takes a few minutes on first run.
      </p>

      <Callout type="info">
        Auth is disabled by default in local development. You&apos;ll be logged in as a synthetic
        &quot;Local Dev&quot; user automatically.
      </Callout>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Access the Dashboard</h3>
      <p className="mt-3 text-text-muted leading-relaxed">Once setup completes, open:</p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Dashboard:</strong>{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            http://localhost
          </code>
        </li>
        <li>
          <strong className="text-text-heading">API health:</strong>{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            http://localhost/api/health
          </code>
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">First Task</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        From the dashboard, connect a GitHub repository, then create a task:
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-2 text-[14px] text-text-muted">
        <li>
          Go to <strong className="text-text-heading">Repos</strong> and add a repository
        </li>
        <li>
          Configure your API keys in <strong className="text-text-heading">Secrets</strong>{" "}
          (Anthropic API key or Claude OAuth token)
        </li>
        <li>
          Go to <strong className="text-text-heading">Tasks &rarr; New Task</strong>
        </li>
        <li>Select your repo, write a prompt, and submit</li>
      </ol>
      <p className="mt-3 text-text-muted leading-relaxed">
        Optio will provision a pod, create a worktree, run the agent, and open a PR. You can watch
        the live logs in the task detail view.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">What Happens Next</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Once the PR is opened, the feedback loop kicks in. Optio polls the PR every 30 seconds:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">CI fails</strong> — the agent is resumed with the
          failure context
        </li>
        <li>
          <strong className="text-text-heading">Review requests changes</strong> — the agent picks
          up the review comments
        </li>
        <li>
          <strong className="text-text-heading">CI passes + approved</strong> — the PR is
          squash-merged and the issue is closed
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Next Steps</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "Installation",
            href: "/docs/installation",
            description: "Full installation guide for local and production",
          },
          {
            title: "Architecture",
            href: "/docs/architecture",
            description: "How the system works under the hood",
          },
          {
            title: "Configuration",
            href: "/docs/configuration",
            description: "Environment variables and Helm values",
          },
          {
            title: "Task Lifecycle",
            href: "/docs/task-lifecycle",
            description: "States, transitions, and the feedback loop",
          },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="card-hover rounded-lg border border-border bg-bg-card p-4 block"
          >
            <p className="text-[14px] font-semibold text-text-heading">{item.title}</p>
            <p className="mt-1 text-[13px] text-text-muted">{item.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
