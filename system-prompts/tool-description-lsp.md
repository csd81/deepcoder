<!-- adapted-from: tool-description-lsp.md -->
Interact with LSP servers for code intelligence.

Operations:
- goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol
- goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls

All operations require: filePath, line (1-based), character (1-based).
workspaceSymbol also takes a query param.
LSP servers must be configured for the file type — error returned if none available.
