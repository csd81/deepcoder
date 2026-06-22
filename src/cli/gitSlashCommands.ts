/**
 * Git workflow slash commands. One dispatcher (`handleGit`) over the typed `Git`
 * helper + `confirmGitAction`. Mutating commands confirm via readline (these
 * commands run on the suspended/normal screen — see tuiSlashRouting) and are
 * refused under active workspace isolation.
 */
import readline from "node:readline";
import chalk from "chalk";
import { Git } from "../workspace/git.js";
import { confirmGitAction } from "./gitConfirm.js";
import type { Session } from "./repl.js";

/** Slash commands handled by handleGit. */
const GIT_COMMANDS = new Set([
  "log", "branch", "commit", "stash", "revert", "reset", "amend",
  "blame", "push", "pull", "rebase", "merge", "cherry-pick",
]);

export function isGitCommand(cmd: string): boolean {
  return GIT_COMMANDS.has(cmd);
}

/** Mutating git commands that must not run while a slice is isolated. */
const MUTATING = new Set(["commit", "revert", "reset", "amend", "push", "pull", "rebase", "merge", "cherry-pick"]);

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
        console.log(await git.log(Number.isFinite(n) && n > 0 ? n : 10));
        return;
      }
      case "blame": {
        if (!a) { console.log(chalk.dim("usage: /blame <file>")); return; }
        console.log(await git.blame(a));
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
        const { current } = await git.branches();
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
  await git.checkout(parts[0]);
  console.log(chalk.green(`Switched to ${parts[0]}.`));
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
