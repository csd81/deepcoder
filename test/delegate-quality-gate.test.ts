import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseAndNormalizeReviewerOutput, runQualityGate } from "../src/delegate/qualityGate.js";
import type { WorkerTask } from "../src/delegate/types.js";
import type { QualityGateOptions } from "../src/config/config.js";
import type { ModelProvider } from "../src/providers/types.js";
import type { SubagentResult, SubagentTrace } from "../src/subagents/types.js";

describe("parseAndNormalizeReviewerOutput", () => {
  test("parses valid JSON with verdict and findings", () => {
    const text = `
Some conversational text before JSON.
{
  "summary": "Looks good",
  "verdict": "pass",
  "findings": [
    {
      "severity": "low",
      "claim": "Minor nit",
      "evidence": "line 10",
      "path": "src/index.ts"
    }
  ],
  "suggestedNextSteps": []
}
`;
    const result = parseAndNormalizeReviewerOutput(text);
    assert.equal(result.verdict, "pass");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "low");
    assert.equal(result.findings[0].claim, "Minor nit");
    assert.equal(result.findings[0].evidence, "line 10");
    assert.equal(result.findings[0].path, "src/index.ts");
  });

  test("truncates long fields and caps findings count", () => {
    const longClaim = "a".repeat(300);
    const longEvidence = "b".repeat(300);
    const longPath = "c".repeat(300);

    const findingsArray = Array.from({ length: 30 }, (_, i) => ({
      severity: "medium",
      claim: `${i}: ${longClaim}`,
      evidence: longEvidence,
      path: longPath,
    }));

    const text = JSON.stringify({
      summary: "Too many findings",
      verdict: "needs_revision",
      findings: findingsArray,
    });

    const result = parseAndNormalizeReviewerOutput(text);
    assert.equal(result.verdict, "needs_revision");
    assert.equal(result.findings.length, 20); // capped at 20
    assert.equal(result.findings[0].claim.length, 200); // truncated
    assert.equal(result.findings[0].evidence?.length, 200); // truncated
    assert.equal(result.findings[0].path?.length, 100); // truncated
  });

  test("throws on malformed JSON", () => {
    assert.throws(() => {
      parseAndNormalizeReviewerOutput("not json");
    }, /Malformed reviewer output/);
  });

  test("throws on invalid verdict", () => {
    assert.throws(() => {
      parseAndNormalizeReviewerOutput(JSON.stringify({ verdict: "invalid_verdict" }));
    }, /invalid verdict/);
  });
});

describe("runQualityGate", () => {
  const mockTask: WorkerTask = {
    id: "task-1",
    title: "Test Task",
    prompt: "Do something",
    allowedPaths: ["src/"],
    forbiddenPaths: ["test/"],
    checkName: "test",
    maxAttempts: 1,
    dependsOn: [],
    expectedOutputs: [],
    status: "running",
  };

  const mockProvider: ModelProvider = {
    id: "mock-provider",
    name: "Mock Provider",
    apiType: "openai",
    apiKey: "mock-key",
  };

  const defaultOptions: QualityGateOptions = {
    enabled: true,
    mode: "mandatory",
    blockOnReviewerError: true,
    minimumBlockingSeverity: "high",
    maxPatchBytes: 10000,
    maxContextBytes: 100000,
  };

  test("passes when verdict is pass and no blocking findings", async () => {
    const mockRunner = async (): Promise<{ result: SubagentResult; trace: SubagentTrace; finalText: string }> => {
      return {
        result: {
          profile: "reviewer",
          task: "review",
          summary: "Looks good",
          findings: [],
          suggestedNextSteps: [],
          errors: [],
        },
        trace: {
          toolsCalled: ["read_file"],
          turns: 1,
          model: "mock-model",
        },
        finalText: JSON.stringify({
          verdict: "pass",
          findings: [
            {
              severity: "low",
              claim: "Minor nit",
            },
          ],
        }),
      };
    };

    const gate = await runQualityGate({
      workspaceRoot: "/tmp",
      provider: mockProvider,
      parentModel: "mock-model",
      compactAt: 10,
      signal: new AbortController().signal,
      task: mockTask,
      patchText: "diff --git a/src/index.ts b/src/index.ts",
      changedFiles: ["src/index.ts"],
      deterministicSummary: "All checks passed",
      options: defaultOptions,
      reviewerRunner: mockRunner,
    });

    assert.equal(gate.passed, true);
    assert.equal(gate.blocked, false);
    assert.equal(gate.findings.length, 1);
    assert.equal(gate.findings[0].severity, "low");
  });

  test("blocks when verdict is block", async () => {
    const mockRunner = async (): Promise<{ result: SubagentResult; trace: SubagentTrace; finalText: string }> => {
      return {
        result: {
          profile: "reviewer",
          task: "review",
          summary: "Blocked",
          findings: [],
          suggestedNextSteps: [],
          errors: [],
        },
        trace: {
          toolsCalled: [],
          turns: 1,
          model: "mock-model",
        },
        finalText: JSON.stringify({
          verdict: "block",
          findings: [],
        }),
      };
    };

    const gate = await runQualityGate({
      workspaceRoot: "/tmp",
      provider: mockProvider,
      parentModel: "mock-model",
      compactAt: 10,
      signal: new AbortController().signal,
      task: mockTask,
      patchText: "diff --git a/src/index.ts b/src/index.ts",
      changedFiles: ["src/index.ts"],
      deterministicSummary: "All checks passed",
      options: defaultOptions,
      reviewerRunner: mockRunner,
    });

    assert.equal(gate.passed, false);
    assert.equal(gate.blocked, true);
  });

  test("blocks when finding severity is at or above minimumBlockingSeverity", async () => {
    const mockRunner = async (): Promise<{ result: SubagentResult; trace: SubagentTrace; finalText: string }> => {
      return {
        result: {
          profile: "reviewer",
          task: "review",
          summary: "High severity finding",
          findings: [],
          suggestedNextSteps: [],
          errors: [],
        },
        trace: {
          toolsCalled: [],
          turns: 1,
          model: "mock-model",
        },
        finalText: JSON.stringify({
          verdict: "pass",
          findings: [
            {
              severity: "high",
              claim: "Critical bug",
            },
          ],
        }),
      };
    };

    const gate = await runQualityGate({
      workspaceRoot: "/tmp",
      provider: mockProvider,
      parentModel: "mock-model",
      compactAt: 10,
      signal: new AbortController().signal,
      task: mockTask,
      patchText: "diff --git a/src/index.ts b/src/index.ts",
      changedFiles: ["src/index.ts"],
      deterministicSummary: "All checks passed",
      options: defaultOptions,
      reviewerRunner: mockRunner,
    });

    assert.equal(gate.passed, false);
    assert.equal(gate.blocked, true);
  });

  test("handles reviewer errors and blocks when blockOnReviewerError is true", async () => {
    const mockRunner = async (): Promise<{ result: SubagentResult; trace: SubagentTrace; finalText: string }> => {
      return {
        result: {
          profile: "reviewer",
          task: "review",
          summary: "Error",
          findings: [],
          suggestedNextSteps: [],
          errors: ["Timeout"],
        },
        trace: {
          toolsCalled: [],
          turns: 1,
          model: "mock-model",
        },
        finalText: "",
      };
    };

    const gate = await runQualityGate({
      workspaceRoot: "/tmp",
      provider: mockProvider,
      parentModel: "mock-model",
      compactAt: 10,
      signal: new AbortController().signal,
      task: mockTask,
      patchText: "diff --git a/src/index.ts b/src/index.ts",
      changedFiles: ["src/index.ts"],
      deterministicSummary: "All checks passed",
      options: defaultOptions,
      reviewerRunner: mockRunner,
    });

    assert.equal(gate.passed, false);
    assert.equal(gate.blocked, true);
    assert.ok(gate.errors.includes("Timeout"));
  });

  test("handles reviewer errors and does not block when blockOnReviewerError is false", async () => {
    const mockRunner = async (): Promise<{ result: SubagentResult; trace: SubagentTrace; finalText: string }> => {
      return {
        result: {
          profile: "reviewer",
          task: "review",
          summary: "Error",
          findings: [],
          suggestedNextSteps: [],
          errors: ["Timeout"],
        },
        trace: {
          toolsCalled: [],
          turns: 1,
          model: "mock-model",
        },
        finalText: "",
      };
    };

    const gate = await runQualityGate({
      workspaceRoot: "/tmp",
      provider: mockProvider,
      parentModel: "mock-model",
      compactAt: 10,
      signal: new AbortController().signal,
      task: mockTask,
      patchText: "diff --git a/src/index.ts b/src/index.ts",
      changedFiles: ["src/index.ts"],
      deterministicSummary: "All checks passed",
      options: {
        ...defaultOptions,
        blockOnReviewerError: false,
      },
      reviewerRunner: mockRunner,
    });

    assert.equal(gate.passed, true);
    assert.equal(gate.blocked, false);
    assert.ok(gate.errors.includes("Timeout"));
  });
});
