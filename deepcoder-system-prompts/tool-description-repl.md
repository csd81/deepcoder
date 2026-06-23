<!-- adapted-from: tool-description-repl.md -->
REPL is a scripting interface to deepcoder's tools. Use it to loop, branch, and compose tool calls.

Write JavaScript that calls tools as async functions:
```javascript
const { filenames } = await Glob({ pattern: 'src/**/*.ts' })
for (const f of filenames) {
  const { file } = await Read({ filePath: f })
  if (file.content.includes('oldName')) {
    await Edit({ filePath: f, old_string: 'oldName', new_string: 'newName', replaceAll: true })
  }
}
```

Batch ALL operations into ONE REPL call — write a complete script.

Available tools as async functions: Glob, Grep, Read, Write, Edit, Bash, etc.

Tips:
- `import`/`require` don't work — use Read/Write/Glob for files, Bash for shell
- Use `Promise.all()` for parallel operations
- Variables persist across REPL calls
- Last expression is returned as the result
