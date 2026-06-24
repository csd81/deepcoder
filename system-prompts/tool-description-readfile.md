<!-- adapted-from: tool-description-readfile.md -->
Reads a file from the local filesystem. Path must be absolute.
- Returns up to 2000 lines by default; use offset/limit for larger files
- Can read images (PNG, JPG, etc.) — presents visually
- Can read PDFs (use pages param for >10 pages, max 20 pages per request)
- Can read Jupyter notebooks (.ipynb) — returns all cells with outputs
- Can only read files, not directories (use Bash for directory listing)
- Reading a non-existent file returns an error
- If file exists but is empty, a system reminder warns instead of returning content
