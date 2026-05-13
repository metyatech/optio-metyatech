# Agent Control Plane - Architecture

## Core Components

1. **Persistent Repository Cache**: Replaces Optio's git worktree logic. Uses full copy semantics from a local cache that includes submodules and LFS.
2. **Multi-Repo Task Model**: Extends Optio's single-repo task model. A task can have multiple associated repos, each with its own PR/CI/merge lifecycle.
3. **OpenCode Runtime Adapter**: Replaces direct Claude Code/etc invocation. Uses metyatech/agent-dotfiles for configuration.
4. **Agent Profile Manager**: Manages auth and state outside of the dotfiles repo to prevent token leakage.
5. **Per-Repository Merge Queue**: Replaces GitHub Merge Queue with an internal locking mechanism to prevent simultaneous merges.
