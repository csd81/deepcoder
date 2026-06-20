import fs from "node:fs";
import path from "node:path";
import type { DependencyHealingConfig } from "../config/config.js";
import type { DependencyFailure } from "./detect.js";

export interface RepairPlan {
  manager: "npm" | "pnpm" | "yarn" | "pip";
  command: string;
  reason: string;
  networkRequired: boolean;
}

export function planRepair(
  workspaceRoot: string,
  failure: DependencyFailure,
  config: DependencyHealingConfig,
): RepairPlan | null {
  if (failure.kind === "none") {
    return null;
  }

  // Helper to check if a file exists in the workspace root
  const hasFile = (filename: string): boolean => {
    return fs.existsSync(path.join(workspaceRoot, filename));
  };

  // Determine if the failure is Node-shaped or Python-shaped
  const isNodeFailure =
    failure.kind === "node_missing_module" ||
    failure.kind === "node_missing_node_modules" ||
    (failure.kind === "package_manager_missing_lockfile" &&
      (failure.manager === "npm" || failure.manager === "pnpm" || failure.manager === "yarn"));

  const isPythonFailure =
    failure.kind === "python_module_not_found" ||
    failure.kind === "python_import_error";

  // 1. Node Manager Selection
  if (isNodeFailure) {
    // Check lockfiles in order of preference
    if (hasFile("pnpm-lock.yaml") && config.managers.includes("pnpm")) {
      return {
        manager: "pnpm",
        command: "pnpm install --frozen-lockfile --ignore-scripts",
        reason: "pnpm-lock.yaml found",
        networkRequired: false,
      };
    }

    if (hasFile("yarn.lock") && config.managers.includes("yarn")) {
      return {
        manager: "yarn",
        command: "yarn install --frozen-lockfile --ignore-scripts",
        reason: "yarn.lock found",
        networkRequired: false,
      };
    }

    if (hasFile("package-lock.json") && config.managers.includes("npm")) {
      return {
        manager: "npm",
        command: "npm ci --ignore-scripts",
        reason: "package-lock.json found",
        networkRequired: false,
      };
    }

    // package.json only
    if (hasFile("package.json") && config.managers.includes("npm")) {
      if (!config.preferFrozenLockfile && config.network === "on") {
        return {
          manager: "npm",
          command: "npm install --ignore-scripts --package-lock-only=false",
          reason: "package.json found, non-frozen allowed with network",
          networkRequired: true,
        };
      }
    }
  }

  // 2. Python Manager Selection
  if (isPythonFailure && config.managers.includes("pip")) {
    if (hasFile("requirements.txt")) {
      return {
        manager: "pip",
        command: "python -m pip install -r requirements.txt",
        reason: "requirements.txt found",
        networkRequired: true,
      };
    }

    if (hasFile("pyproject.toml") && hasFile("uv.lock")) {
      return {
        manager: "pip", // Map uv to pip manager category
        command: "uv sync --frozen",
        reason: "pyproject.toml and uv.lock found",
        networkRequired: false,
      };
    }
  }

  return null;
}
