<!-- adapted-from: tool-description-bash-maintain-cwd.md -->
- Use absolute paths and avoid `cd`. Never prepend `cd <dir>` to git commands — git already operates on the current tree and the compound triggers a permission prompt.
