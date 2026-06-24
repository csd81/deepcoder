/**
 * Git workflow slash commands. One dispatcher (`handleGit`) over the typed `Git`
 * helper + `confirmGitAction`. Mutating commands confirm via readline (these
 * commands run on the suspended/normal screen — see tuiSlashRouting) and are
 * refused under active workspace isolation.
 */
import readline from "node:readline";
import chalk from "chalk";
import { Git } from "../workspace/git.js";
import { generateCommitMessage } from "./commitMessage.js";
import { confirmGitAction } from "./gitConfirm.js";
import { prePushReview } from "./prePushReview.js";
import { runMultiAngleReview } from "../delegate/multiAngleReview.js";
import { runSubagent } from "../subagents/runner.js";
import { verifyFindings } from "../delegate/verifyFindings.js";
import type { SubagentFinding } from "../subagents/types.js";
import type { Session } from "./repl.js";
import type { AgentMessage } from "../providers/types.js";

/** Slash commands handled by handleGit. */
const GIT_COMMANDS = new Set([
  "log", "branch", "commit", "commit-msg", "stash", "revert", "reset", "amend",
  "blame", "push", "pull", "rebase", "merge", "cherry-pick",
  "show", "files", "stage", "restore", "apply", "worktree", "tag",
]);

export function isGitCommand(cmd: string): boolean {
  return GIT_COMMANDS.has(cmd);
}

/** Mutating git commands that must not run while a slice is isolated. */
const MUTATING = new Set([
  "commit", "commit-msg", "revert", "reset", "amend", "push", "pull", "rebase", "merge", "cherry-pick",
  "stage", "restore", "apply", "worktree", "tag",
]);

function ask(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(promptText, (answer) => { rl.close(); res(answer.trim()); }));
}

function isolationBlocked(cmd: string, session: Session): boolean {
  if (MUTATING.has(cmd) && session.isolation) {
    console.log(chalk.yellow("Workspace isolation is active. Run `/isolation apply` first to land changes in the real repo."));
    return true;
  }
  return false;
}

export async function handleGit(cmd: string, session: Session, arg: string): Promise<void> {
  const git = new Git(session.config.workspaceRoot);
  if (!(await git.isRepo())) { console.log(chalk.dim("Not a git repository.")); return; }
  if (isolationBlocked(cmd, session)) return;
  const a = arg.trim();
  try {
    switch (cmd) {
      case "log": {
        const n = Number.parseInt(a, 10);
        try {
          const total = await git.revListCount("HEAD");
          console.log(chalk.dim(`${total} commit${total === 1 ? "" : "s"} total`));
        } catch { /* unborn branch / no commits — skip the count header */ }
        console.log(await git.log(Number.isFinite(n) && n > 0 ? n : 10));
        return;
      }
      case "blame": {
        if (!a) { console.log(chalk.dim("usage: /blame <file>")); return; }
        console.log(await git.blame(a));
        return;
      }
      case "show": {
        console.log(await git.show(a || undefined));
        return;
      }
      case "files": {
        const paths = a ? a.split(/\s+/).filter(Boolean) : undefined;
        const files = await git.lsFiles(paths);
        console.log(files.length ? files.join("\n") : chalk.dim("No tracked files."));
        return;
      }
      case "branch": return await handleBranch(git, a);
      case "stash": return await handleStash(git, a);
      case "commit": {
        const msg = a.replace(/^-m\s+/, "").trim() || (await ask("Commit message: "));
        if (!msg) { console.log(chalk.red("Commit message required.")); return; }
        const preview = (await git.diffStaged()) || (await git.status()) || "No staged changes.";
        const ok = await confirmGitAction({ label: `git commit -m "${msg.slice(0, 60)}${msg.length > 60 ? "…" : ""}"`, detail: preview, dangerLevel: "safe" }, ask);
        // safe → confirmGitAction returns true without prompting; commit proceeds.
        if (!ok) return;
        console.log(chalk.green((await git.commit(msg)).stdout));
        return;
      }
      case "commit-msg": {
        // 1. Gather the combined staged + unstaged diff (bounded by the generator).
        const staged = (await git.diffStaged()).trim();
        const unstaged = (await git.diff()).trim();
        const combined = [staged, unstaged].filter(Boolean).join("\n");
        if (!combined) { console.log(chalk.yellow("Nothing to commit (working tree clean).")); return; }

        // 2. Recent history for style reference.
        const recentHistory = await git.log(10);

        // 3. Generate via the session provider (injected as callLLM).
        console.log(chalk.dim("Generating commit message…"));
        const callLLM = async (systemPrompt: string, userPrompt: string): Promise<string> => {
          const messages: AgentMessage[] = [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ];
          const res = await session.provider.chat({ messages, tools: [], model: session.config.model });
          return res.text;
        };
        const msg = await generateCommitMessage(combined, recentHistory, callLLM);
        console.log(chalk.bold(`\nGenerated: ${chalk.green(msg)}\n`));

        // 4. Confirm at "normal" — the user reviews the AI-written message before it lands.
        const ok = await confirmGitAction({
          label: `git commit -m "${msg.slice(0, 60)}${msg.length > 60 ? "…" : ""}"`,
          detail: "AI-generated Conventional Commits message — review before committing.",
          diff: combined.slice(0, 2000),
          dangerLevel: "normal",
        }, ask);
        if (!ok) return;

        // 5. Commit (stages all tracked modifications, same as /commit).
        console.log(chalk.green((await git.commit(msg)).stdout));
        return;
      }
      case "amend": {
        const msg = a.replace(/^-m\s+/, "").trim();
        const ok = await confirmGitAction({ label: `git commit --amend${msg ? ` -m "${msg.slice(0, 60)}"` : " (keep message)"}`, diff: await git.diffStaged(), dangerLevel: "normal" }, ask);
        if (!ok) return;
        console.log(chalk.green((await git.amend(msg)).stdout));
        return;
      }
      case "revert": {
        if (!a) { console.log(chalk.dim("usage: /revert <commit>")); return; }
        if (!(await confirmGitAction({ label: `git revert ${a}`, dangerLevel: "normal" }, ask))) return;
        console.log(chalk.green(await git.revert(a)));
        return;
      }
      case "cherry-pick": {
        if (!a) { console.log(chalk.dim("usage: /cherry-pick <commit>")); return; }
        if (!(await confirmGitAction({ label: `git cherry-pick ${a}`, dangerLevel: "normal" }, ask))) return;
        console.log(chalk.green(await git.cherryPick(a)));
        return;
      }
      case "reset": {
        const parts = a.split(/\s+/).filter(Boolean);
        const mode = (parts.find((p) => p.startsWith("--"))?.slice(2) ?? "mixed") as "soft" | "mixed" | "hard";
        const ref = parts.find((p) => !p.startsWith("--")) ?? "HEAD";
        if (!(await confirmGitAction({ label: `git reset --${mode} ${ref}`, detail: mode === "hard" ? "Discards uncommitted changes." : undefined, dangerLevel: mode === "hard" ? "dangerous" : "normal" }, ask))) return;
        console.log(chalk.green(await git.reset(ref, mode)));
        return;
      }
      case "push": {
        const force = /(^|\s)--force(\s|$)/.test(a);
        const wantReview = /(^|\s)--review(\s|$)/.test(a);
        const { current } = await git.branches();
        if (wantReview && !(await prePushGate(git, session, current))) {
          console.log(chalk.dim("Push aborted by pre-push review."));
          return;
        }
        if (!(await confirmGitAction({ label: `git push origin ${current}${force ? " --force-with-lease" : ""}`, dangerLevel: force ? "dangerous" : "normal" }, ask))) return;
        console.log(chalk.green(await git.push("origin", current, force)));
        return;
      }
      case "pull": {
        const rebase = /(^|\s)--rebase(\s|$)/.test(a);
        const { current } = await git.branches();
        if (!(await confirmGitAction({ label: `git pull${rebase ? " --rebase" : ""} origin ${current}`, dangerLevel: "normal" }, ask))) return;
        console.log(chalk.green(await git.pull("origin", current, rebase)));
        return;
      }
      case "merge": {
        if (!a) { console.log(chalk.dim("usage: /merge <branch>")); return; }
        if (!(await confirmGitAction({ label: `git merge ${a}`, dangerLevel: "normal" }, ask))) return;
        const res = await git.merge(a);
        if (res.ok) console.log(chalk.green(`Merged ${a}.`));
        else console.log(chalk.yellow(`Merge conflicts in: ${(res.conflicts ?? []).join(", ")}. Resolve them, then commit (or /resolve).`));
        return;
      }
      case "rebase": {
        if (!a) { console.log(chalk.dim("usage: /rebase <branch>")); return; }
        if (!(await confirmGitAction({ label: `git rebase ${a}`, detail: "May require a force-push afterwards.", dangerLevel: "normal" }, ask))) return;
        const res = await git.rebase(a);
        if (res.ok) console.log(chalk.green(`Rebased onto ${a}.`));
        else console.log(chalk.yellow(`Rebase conflicts in: ${(res.conflicts ?? []).join(", ")}. Resolve them, then \`git rebase --continue\`.`));
        return;
      }
      case "stage": {
        // `/stage [-A | <paths...>]` — stage everything or the given paths.
        const all = /(^|\s)-A(\s|$)/.test(a);
        const paths = a.replace(/(^|\s)-A(\s|$)/, " ").split(/\s+/).filter(Boolean);
        if (!all && paths.length === 0) { console.log(chalk.dim("usage: /stage [-A | <path...>]")); return; }
        await git.stage(all ? { all: true } : { paths });
        console.log(chalk.green(all ? "Staged all changes." : `Staged ${paths.length} path(s).`));
        return;
      }
      case "restore": {
        // `/restore [--staged] <paths...>` — discard working-tree changes, or with
        // --staged unstage them. Discarding work is destructive → dangerous gate.
        const staged = /(^|\s)--staged(\s|$)/.test(a);
        const paths = a.replace(/(^|\s)--staged(\s|$)/, " ").split(/\s+/).filter(Boolean);
        if (paths.length === 0) { console.log(chalk.dim("usage: /restore [--staged] <path...>")); return; }
        const label = staged ? `git restore --staged ${paths.join(" ")}` : `git restore ${paths.join(" ")}`;
        if (!(await confirmGitAction({ label, detail: staged ? "Unstages the given paths." : "Discards uncommitted changes to the given paths.", dangerLevel: staged ? "normal" : "dangerous" }, ask))) return;
        await git.restore(paths, staged);
        console.log(chalk.green(staged ? `Unstaged ${paths.length} path(s).` : `Restored ${paths.length} path(s).`));
        return;
      }
      case "apply": {
        // `/apply <patch-file> [--check] [--3way]`
        const check = /(^|\s)--check(\s|$)/.test(a);
        const threeWay = /(^|\s)--3way(\s|$)/.test(a);
        const file = a.replace(/(^|\s)--(check|3way)(\s|$)/g, " ").trim();
        if (!file) { console.log(chalk.dim("usage: /apply <patch-file> [--check] [--3way]")); return; }
        if (!check && !(await confirmGitAction({ label: `git apply ${file}${threeWay ? " --3way" : ""}`, dangerLevel: "normal" }, ask))) return;
        const out = await git.applyPatch(file, { check, threeWay });
        console.log(chalk.green(check ? `Patch applies cleanly.${out ? `\n${out}` : ""}` : `Applied ${file}.${out ? `\n${out}` : ""}`));
        return;
      }
      case "worktree": return await handleWorktree(git, a);
      case "tag": return await handleTag(git, a);
    }
  } catch (e) {
    console.log(chalk.red(`git ${cmd} failed: ${(e as Error).message}`));
  }
}

async function handleBranch(git: Git, a: string): Promise<void> {
  const parts = a.split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0] === "list") {
    const b = await git.branches();
    for (const name of b.local) console.log(`${name === b.current ? chalk.green("* ") : "  "}${name}`);
    return;
  }
  if (parts[0] === "-c" && parts[1]) {
    await git.createBranch(parts[1]);
    console.log(chalk.green(`Switched to new branch ${parts[1]}.`));
    return;
  }
  if (parts[0] === "-d" && parts[1]) {
    if (!(await confirmGitAction({ label: `git branch -d ${parts[1]}`, dangerLevel: "dangerous" }, ask))) return;
    await git.deleteBranch(parts[1]);
    console.log(chalk.green(`Deleted branch ${parts[1]}.`));
    return;
  }
  if (parts[0] === "-m" && parts[1] && parts[2]) {
    await git.renameBranch(parts[1], parts[2]);
    console.log(chalk.green(`Renamed branch ${parts[1]} → ${parts[2]}.`));
    return;
  }
  await git.checkout(parts[0]);
  console.log(chalk.green(`Switched to ${parts[0]}.`));
}

async function handleWorktree(git: Git, a: string): Promise<void> {
  const [sub, ...rest] = a.split(/\s+/).filter(Boolean);
  const subCmd = sub || "list";
  if (subCmd === "list") { console.log((await git.worktreeList()) || chalk.dim("No linked worktrees.")); return; }
  if (subCmd === "add") {
    // `/worktree add <dir> [-b <branch>]`
    const dir = rest.find((p) => !p.startsWith("-"));
    const bIdx = rest.indexOf("-b");
    const branch = bIdx >= 0 ? rest[bIdx + 1] : undefined;
    if (!dir) { console.log(chalk.dim("usage: /worktree add <dir> [-b <branch>]")); return; }
    if (!(await confirmGitAction({ label: `git worktree add${branch ? ` -b ${branch}` : ""} ${dir}`, dangerLevel: "normal" }, ask))) return;
    await git.worktreeAdd(dir, branch);
    console.log(chalk.green(`Added worktree ${dir}.`));
    return;
  }
  if (subCmd === "remove") {
    const force = rest.includes("--force");
    const dir = rest.find((p) => !p.startsWith("-"));
    if (!dir) { console.log(chalk.dim("usage: /worktree remove <dir> [--force]")); return; }
    if (!(await confirmGitAction({ label: `git worktree remove${force ? " --force" : ""} ${dir}`, dangerLevel: "dangerous" }, ask))) return;
    await git.worktreeRemove(dir, force);
    console.log(chalk.green(`Removed worktree ${dir}.`));
    return;
  }
  if (subCmd === "prune") {
    await git.worktreePrune();
    console.log(chalk.green("Pruned stale worktree records."));
    return;
  }
  console.log(chalk.dim("usage: /worktree [list|add <dir> [-b <branch>]|remove <dir> [--force]|prune]"));
}

async function handleTag(git: Git, a: string): Promise<void> {
  const parts = a.split(/\s+/).filter(Boolean);
  if (parts[0] === "-d" && parts[1]) {
    if (!(await confirmGitAction({ label: `git tag -d ${parts[1]}`, dangerLevel: "dangerous" }, ask))) return;
    await git.deleteTag(parts[1]);
    console.log(chalk.green(`Deleted tag ${parts[1]}.`));
    return;
  }
  if (parts[0] === "-a" && parts[1]) {
    // `/tag -a <name> [-m <message>]` — annotated tag
    const mIdx = parts.indexOf("-m");
    const message = mIdx >= 0 ? parts.slice(mIdx + 1).join(" ") : undefined;
    await git.createTag(parts[1], message || parts[1]);
    console.log(chalk.green(`Created annotated tag ${parts[1]}.`));
    return;
  }
  if (parts[0]) {
    await git.createTag(parts[0]);
    console.log(chalk.green(`Created tag ${parts[0]}.`));
    return;
  }
  console.log(chalk.dim("usage: /tag <name> | /tag -a <name> [-m <msg>] | /tag -d <name>"));
}

async function handleStash(git: Git, a: string): Promise<void> {
  const [sub, ...rest] = a.split(/\s+/).filter(Boolean);
  const subCmd = sub || "save";
  if (subCmd === "save") { await git.stashSave(rest.join(" ") || undefined); console.log(chalk.green("Changes stashed.")); return; }
  if (subCmd === "list") { console.log((await git.stashList()) || chalk.dim("No stashes.")); return; }
  if (subCmd === "pop") {
    if (!(await confirmGitAction({ label: "git stash pop", dangerLevel: "normal" }, ask))) return;
    await git.stashPop(rest[0] ? Number.parseInt(rest[0], 10) : undefined);
    console.log(chalk.green("Stash popped."));
    return;
  }
  if (subCmd === "drop") {
    if (!(await confirmGitAction({ label: "git stash drop", dangerLevel: "dangerous" }, ask))) return;
    await git.stashDrop(rest[0] ? Number.parseInt(rest[0], 10) : undefined);
    console.log(chalk.green("Stash dropped."));
    return;
  }
  console.log(chalk.dim("usage: /stash [save|pop|list|drop]"));
}

/** Run a low-effort multi-angle review over a diff, returning its raw findings. */
async function reviewDiffFindings(session: Session, diff: string): Promise<SubagentFinding[]> {
  const controller = new AbortController();
  const opts = {
    workspaceRoot: session.config.workspaceRoot,
    provider: session.provider,
    parentModel: session.config.model,
    subagentModel: session.config.subagentModel,
    contextBudgetTokens: session.config.contextBudgetTokens,
    compactAt: session.config.compactAt,
    signal: controller.signal,
  };
  const result = await runMultiAngleReview(
    `Review this outgoing diff before it is pushed. Report bugs, regressions, and missing tests:\n\n${diff}`,
    "low",
    { runSubagent, verifyFindings, opts },
  );
  return result.findings;
}

/**
 * `/push --review` gate: review the outgoing diff before anything leaves the
 * machine. Findings never silently block — they're surfaced and require an
 * explicit confirm to push anyway. Returns true if the push may proceed.
 */
async function prePushGate(git: Git, session: Session, current: string): Promise<boolean> {
  let diff = "";
  try {
    diff = (await git.run(["diff", `origin/${current}...HEAD`])).trim();
  } catch {
    diff = await git.diff(); // no upstream yet → fall back to the working diff
  }
  if (!diff) return true; // nothing outgoing → nothing to review
  console.log(chalk.dim("Running pre-push review (low-effort)…"));
  const review = await prePushReview(diff, (d) => reviewDiffFindings(session, d));
  if (review.ok) {
    console.log(chalk.green("Pre-push review: no issues found."));
    return true;
  }
  console.log(chalk.yellow(`Pre-push review found ${review.issues.length} issue(s):`));
  for (const issue of review.issues) console.log(`  ${issue}`);
  return confirmGitAction(
    { label: `push despite ${review.issues.length} review finding(s)`, dangerLevel: "dangerous" },
    ask,
  );
}
