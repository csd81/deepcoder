import fs from "node:fs";
import path from "node:path";

export interface DependencyFailureInput {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  workspaceRoot: string;
}

export type DependencyFailure =
  | { kind: "node_missing_module"; moduleName?: string }
  | { kind: "node_missing_node_modules" }
  | { kind: "python_module_not_found"; moduleName?: string }
  | { kind: "python_import_error"; moduleName?: string }
  | { kind: "package_manager_missing_lockfile"; manager: string }
  | { kind: "none" };

const EXCLUSION_PATTERNS = [
  /AssertionError/i,
  /expect\(/i,
  /assert\./i,
  /SyntaxError/i,
  /TypeError/i,
  /ReferenceError/i,
  /NameError/i,
  /AttributeError/i,
  /error TS\d+:/i,
];

export function detectDependencyFailure(input: DependencyFailureInput): DependencyFailure {
  if (input.exitCode === 0 || input.timedOut) {
    return { kind: "none" };
  }

  // Check exclusions first to be conservative
  for (const pattern of EXCLUSION_PATTERNS) {
    if (pattern.test(input.output)) {
      return { kind: "none" };
    }
  }

  const output = input.output;

  // 1. Lock/setup missing errors
  if (output.includes("pnpm-lock.yaml is absent")) {
    return { kind: "package_manager_missing_lockfile", manager: "pnpm" };
  }
  if (output.includes("package-lock.json not found")) {
    return { kind: "package_manager_missing_lockfile", manager: "npm" };
  }
  if (/npm ERR! Missing:.*from lock file/i.test(output)) {
    return { kind: "package_manager_missing_lockfile", manager: "npm" };
  }

  // 2. Node missing node_modules or specific modules
  const nodeModulesPath = path.join(input.workspaceRoot, "node_modules");
  const hasNodeModules = fs.existsSync(nodeModulesPath);

  const cannotFindModuleMatch = output.match(/Cannot find module ['"]([^'"]+)['"]/);
  const errModuleNotFound = output.includes("ERR_MODULE_NOT_FOUND") || output.includes("Error [ERR_MODULE_NOT_FOUND]");
  const tsxNotFound = /sh: \d+: tsx: not found/i.test(output) || /sh: tsx: not found/i.test(output) || /tsx: command not found/i.test(output);
  const binNotFound = /node_modules\/\.bin\/[^\s:]+: not found/i.test(output);

  if (!hasNodeModules && (cannotFindModuleMatch || errModuleNotFound || tsxNotFound || binNotFound)) {
    return { kind: "node_missing_node_modules" };
  }

  if (cannotFindModuleMatch) {
    return { kind: "node_missing_module", moduleName: cannotFindModuleMatch[1] };
  }
  if (errModuleNotFound) {
    return { kind: "node_missing_module" };
  }
  if (tsxNotFound || binNotFound) {
    return { kind: "node_missing_node_modules" };
  }

  // 3. Python missing virtualenv or modules
  const venvPath = path.join(input.workspaceRoot, ".venv");
  const hasVenv = fs.existsSync(venvPath);

  const pythonModuleNotFoundMatch = output.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/);
  const pythonImportErrorMatch = output.match(/ImportError: No module named ([^\s']+)/);
  const pytestNotFound = /pytest: command not found/i.test(output) || /pytest: not found/i.test(output);
  const pythonVenvNotFound = /\.venv\/bin\/python: not found/i.test(output) || /\.venv\/bin\/[^\s:]+: not found/i.test(output);

  if (pythonModuleNotFoundMatch) {
    return { kind: "python_module_not_found", moduleName: pythonModuleNotFoundMatch[1] };
  }
  if (pythonImportErrorMatch) {
    return { kind: "python_import_error", moduleName: pythonImportErrorMatch[1] };
  }
  if (pytestNotFound || pythonVenvNotFound) {
    if (!hasVenv) {
      // If .venv is missing, we can treat it as a general python module/env issue
      return { kind: "python_module_not_found" };
    }
  }

  return { kind: "none" };
}
