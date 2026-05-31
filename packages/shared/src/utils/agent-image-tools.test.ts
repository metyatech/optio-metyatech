import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../../../");

function readAgentBaseDockerfile(): string {
  return readFileSync(join(ROOT, "images", "base.Dockerfile"), "utf-8");
}

describe("agent base image tools", () => {
  it("installs PowerShell 7 in the shared base image", () => {
    const dockerfile = readAgentBaseDockerfile();

    expect(dockerfile).toContain("packages.microsoft.com/config/ubuntu/${VERSION_ID}");
    expect(dockerfile).toContain("apt-get install -y powershell");
    expect(dockerfile).toContain("pwsh -NoLogo -NoProfile");
    expect(dockerfile).toContain("$PSVersionTable.PSVersion.Major -lt 7");
  });
});
