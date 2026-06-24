# Feature Plan: Managed Tool Output Files (Large Output Offloading)

This plan outlines the design and implementation for **Managed Tool Output Files** in [deepcoder](file:///home/csd81/Desktop/deepcoder/README.md), inspired by the large-output offloading architecture of [opencode](file:///home/csd81/Desktop/opencode/CONTEXT.md). 

---

## 1. Problem Statement & Motivation

During execution, tools like `run_bash` (running test suites) or file operations can output massive blocks of text. Currently, `deepcoder` handles this by applying [`capToolResult`](file:///home/csd81/Desktop/deepcoder/src/agent/agentLoop.ts#L140), which crops outputs exceeding 100KB (`MAX_TOOL_RESULT_BYTES`) and discards the remainder.

This leads to **diagnostic blindness**:
* If a linter, compiler, or test run outputs a long stream of logs and the actual failure traceback occurs at the end, it gets truncated.
* The model cannot read the error details, causing it to loop or guess blindly.
* Large raw outputs cannot be processed by other sub-agents or read-only tools.

---

## 2. Proposed Architecture

Instead of discarding truncated text, `deepcoder` will offload the complete, raw tool output to a structured local directory and store a truncated preview in the session history, along with a pointer ID.

```
                  ┌──────────────────────┐
                  │ Tool Execution Output│
                  └──────────┬───────────┘
                             │
                  Is size > 100 KB?
                  /          \
               (Yes)         (No)
                /              \
  ┌────────────▼───────────┐   ┌▼──────────────────────────┐
  │ Write complete output  │   │ Save directly to session  │
  │ to gitignored folder   │   │ history (messages list)   │
  │ .deepcoder/outputs/    │   └───────────────────────────┘
  └────────────┬───────────┘
               │
  ┌────────────▼───────────┐
  │ Append truncated       │
  │ preview + metadata ID  │
  │ to session history     │
  └────────────────────────┘
```

### Key Components

1. **Storage Folder**: A gitignored directory `.deepcoder/outputs/` containing raw files (e.g. `output-[uuid].log`).
2. **Output Tracker**: A session-level map tracking mapped file IDs.
3. **`read_managed_output` tool**: A read-only tool enabling the model to load specific line/byte ranges from an offloaded output if it notices truncation.

---

## 3. Step-by-Step Implementation Plan

### Step 1: Create the Managed Outputs Utility
Create a new file `src/session/managedOutputs.ts` to manage file writes and reads.

* Automatically ensure the `.deepcoder/outputs/` directory exists.
* Implement a helper to write overflow text:
  ```typescript
  import { promises as fs } from "node:fs";
  import * as path from "node:path";
  import { randomUUID } from "node:crypto";

  export async function saveManagedOutput(workspaceRoot: string, content: string): Promise<string> {
    const id = randomUUID();
    const dir = path.join(workspaceRoot, ".deepcoder", "outputs");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `output-${id}.log`), content, "utf8");
    return id;
  }
  ```

### Step 2: Implement the `read_managed_output` Tool
Create a new tool at `src/tools/readManagedOutput.ts`.

* **Arguments**:
  * `outputId` (string, required): The UUID of the offloaded output.
  * `startLine` (number, optional): Start line to slice (1-indexed).
  * `endLine` (number, optional): End line to slice.
* **Confinement**:
  * Resolve path to `.deepcoder/outputs/output-${outputId}.log` and reject any paths that escape the outputs directory.
* Register this tool under `src/tools/registry.ts`.

### Step 3: Integrate with `runAgentLoop`
Update the tool execution phase inside `runAgentLoop` ([agentLoop.ts](file:///home/csd81/Desktop/deepcoder/src/agent/agentLoop.ts#L164)).

1. Locate where tool outcomes are captured and formatted.
2. If `result.output` exceeds `MAX_TOOL_RESULT_BYTES`:
   * Execute `const id = await saveManagedOutput(workspaceRoot, result.output);`
   * Replace the output content stored in the message history with:
     ```
     [... tool result truncated: ${dropped} bytes omitted to fit context budget ...]
     Complete output has been offloaded to disk.
     Available ID: ${id}
     Call read_managed_output(outputId: "${id}", startLine: X, endLine: Y) to read specific ranges of this output.
     ```
3. Keep this truncated block small so it fits easily within the agent's turn history.

### Step 4: Protect Path Guards
Ensure `.deepcoder/outputs/` is added to:
* The sensitive path rules so ordinary file tools (`read_file`, `write_file`) cannot read or write to it directly (only `read_managed_output` has access).
* The `.gitignore` default scanner patterns.

---

## 4. Expected Benefits

* **No Data Loss**: The agent never loses build output data, regardless of test suite size.
* **Lower Context Cost**: Standard turns remain small, while the full logs are preserved and queryable.
* **Deterministic Execution**: Debugging long failing traces becomes reliable.
