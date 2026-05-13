# Agent Control Plane - Decisions

1. **Persistent Cache over Worktrees**: Git worktrees introduce hidden dependencies on the origin repository and complicate cross-worktree submodule/LFS states. We decided to use full cp -a directory copies from a bare/mirror persistent cache for true isolation.
2. **task_repos Table**: To support multi-repo tasks, we introduce a 1-to-N relationship between a task and its repositories, decoupling PR/CI state from the main task.
3. **Agent Profile Manager**: Auth tokens will be kept strictly out of agent-dotfiles to prevent accidental commit leakage.
