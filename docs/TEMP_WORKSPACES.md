# Temporary local workspaces

A temporary workspace is a checkout of a project's GitHub repository that Mini-Summa downloads, owns, and can find again, so that Claude Code can work locally on a repository you do not keep cloned. Everything here is Mini-Summa's own behaviour. Anthropic documents nothing about it; Git and GitHub are used only through the Git program on your PC and your own Git login.

## What you do

1. **Plus button, Temporary local session.** Mini-Summa checks the repository first: whether your Git login can reach it (`git ls-remote`), the branches, GitHub's approximate size, and free disk space.
2. **Read the warnings.** A repository over 500 MB, one whose size GitHub does not report (private repositories often do not), or an unreadable disk needs a tick before the download. Too little disk space stops it. GitHub's size is a hint, not a guarantee, and does not include Git LFS content.
3. **Choose a starting branch** (the default branch is preselected) and, if you want, **a new branch for the work**. It is created locally after the download. Nothing is pushed.
4. **Optionally add the prompt.** It is copied to your clipboard when Claude Code starts; you paste it into the terminal yourself. Mini-Summa types nothing into Claude.
5. **Download and start Claude.** The managed terminal opens in the checkout, exactly like any other local session (same hooks, reports, notifications, `/clear`, `/resume`).
6. **Come back later.** Plus button, Temporary workspaces lists the checkouts of the project. **Continue with Claude** starts another session in the same checkout, also after a restart.
7. **Review and clean up.** See below. Cleanup is never automatic.

## How it is kept

* **Identity.** Each workspace has a uuid. The folder is `<data folder>\workspaces\<uuid>\repo` (on Windows `%APPDATA%\Mini-Summa\data\workspaces`). The repository name appears nowhere in the path, so two workspaces of one repository never collide, and a folder is never reused because its name looks right.
* **Ownership marker.** Before the download starts, Mini-Summa writes `workspace.json` (uuid, project, repository) next to `repo`. Reuse, wiping a failed download and cleanup all first check that the marker, the database row and the path agree. A folder without its marker is not touched.
* **Remote check.** After the download and again every time a session starts, `origin` must still be the project's repository. Otherwise nothing is started in it.
* **Restart and crash.** A download that was running when Mini-Summa ended becomes "Download failed" with a reason and can be retried (the partial folder is wiped first, only inside the workspace folder Mini-Summa made). A finished workspace is listed again after a restart.
* **Cancelling** stops the Git process and removes the partial folder.

## What Mini-Summa does and does not run

* Git is started with an argument array, never through a shell. Terminal prompts are off, so a missing login fails with a message instead of hanging (Git Credential Manager still works). `ext::` and `file::` remotes are refused. The clone address is built from the validated `owner/repo` name only.
* Git LFS files are **not** downloaded (`GIT_LFS_SKIP_SMUDGE`), submodules are **not** fetched, and **no script from the repository is run**: no setup script, no hook of Mini-Summa's own. Claude Code itself, once started, can of course run commands you approve in its terminal.
* Branch names are checked (no leading dash, no `..`, no spaces) and then by `git check-ref-format`.

## When cleanup is offered

"Clean up workspace" appears only after a **fresh** inspection that includes asking GitHub, and only when nothing would be lost. It is refused while any of these holds:

| Check | How |
| --- | --- |
| Claude (or a cloud dispatch) is running in the folder | managed sessions and dispatches registered with the workspace |
| Changed tracked files | `git status` |
| New files Git does not track | `git status` |
| Stashed changes | `git stash list` |
| Commits that exist only here, on **any** branch or a detached HEAD | `git log HEAD --branches --not --remotes` after `git fetch` |
| The branch on GitHub does not have this commit | `git ls-remote origin <branch>` compared with `HEAD` |
| The remote is not the project's repository, or the folder is not the one Mini-Summa made | remote URL, marker |
| The folder overlaps a project folder | project folders are never removed, whichever side contains the other |

A commit alone is not evidence of publication: the check compares the commit with what GitHub reports for that branch. If GitHub cannot be reached, the result says so and uses what was last downloaded; a push you have not made is never assumed. Ignored files (build output, dependencies, local settings) do not block, but are listed because they would be removed.

You then type the repository name to confirm. The folder goes to the **Recycle Bin or Trash**. If the system offers none to Mini-Summa, it says so and requires a separate "Delete permanently" choice. A file that Windows reports as in use (an editor, a terminal, a virus scanner) leaves everything where it is and says so. Pull requests are never opened or merged by Mini-Summa.

## Protecting permanent folders

A temporary session is bound to the project by its record, not by being a project folder. Opening one never adds a root to the project, and a path that is, contains, or lies inside any project folder (for example `C:\Projects\CaissaTrainer`) is refused for cleanup. Tests: `packages/core/test/workspaces/workspaces.test.ts` ("never treats a permanent project folder as disposable") and `packages/core/test/integration/workspaces.test.ts`.

## Cloud dispatch and workspaces

A project with GitHub but no folder can still start a cloud task: Mini-Summa makes a **shallow** workspace (`--depth 1 --filter=blob:none`, purpose "dispatch") only so that the CLI has a repository to run in. It is not listed under Temporary workspaces, and it counts as in use while its dispatch is running.

## Verified and not verified

Verified by automated tests with real Git against a local bare repository that stands in for GitHub: clone, branch selection, feature branch, concurrent workspaces, cancel, failed clone and retry, restart, every blocker above, trash, locked-file failure, permanent-delete gate. **Not verified:** a clone from real GitHub (authentication prompts, Git Credential Manager, large repositories, LFS), real disk-full behaviour, Windows locked files and the Recycle Bin, and `shell.trashItem` itself. These are in [WINDOWS_VERIFICATION.md](WINDOWS_VERIFICATION.md) section D.
