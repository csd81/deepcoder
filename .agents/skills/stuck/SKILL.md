---
name: stuck
description: Diagnose a frozen or slow DeepCoder session by scanning other DeepCoder processes for high CPU, stuck process states (D/T/Z), high RSS, and hung child processes; diagnostic only — never kill or signal processes.
---
<!-- adapted-from: skill-stuck-slash-command.md -->
Diagnose frozen/slow DeepCoder sessions.

Scan for other DeepCoder processes. Signs of stuck sessions:
- High CPU (≥90%) sustained
- Process state D (I/O hang), T (stopped), Z (zombie)
- Very high RSS (≥4GB)
- Stuck child processes (hung git, node, or shell subprocesses)

Use `ps`, `pgrep`, check debug logs. Diagnostic only — do not kill or signal any processes.
