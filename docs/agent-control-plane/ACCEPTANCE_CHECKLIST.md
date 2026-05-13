# Agent Control Plane - Acceptance Checklist

- [x] Task can be created from Optio Web UI with multiple repositories.
- [x] Local persistent repo cache is created/updated (including LFS & submodules).
- [x] Task workspace is created by copying from cache, not via git worktree or remote clone.
- [x] Custom OpenCode runtime runs inside task environment configured by metyatech/agent-dotfiles.
- [x] Agent-dotfiles profile uses Windows or Linux automatically.
- [x] Auth failures transition task into needs-auth state.
- [x] Realtime task output shows OpenCode logs.
- [x] Send additional prompts during task execution works.
- [x] PR created per changed repository.
- [x] Per-repository merge lock prevents simultaneous merges.
- [x] Tests and documentation updated.
