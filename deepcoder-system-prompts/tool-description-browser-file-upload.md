<!-- adapted-from: tool-description-browser-file-upload.md -->
Upload files directly to a page's file input element. Do NOT click file upload buttons — that opens a native dialog. Instead, locate the file input element via read_page or find, then use this tool with its ref.
- Only files shared with the session (attachments, outputs/uploads, connected folders) can be uploaded
- Combined size limit: 10 MB per call
