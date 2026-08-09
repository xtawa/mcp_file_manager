import path from "node:path"

const MIME_BY_EXTENSION: Record<string, string> = {
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".tsv": "text/tab-separated-values; charset=utf-8",
	".log": "text/plain; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".jsonl": "application/x-ndjson",
	".ndjson": "application/x-ndjson",
	".xml": "application/xml; charset=utf-8",
	".yaml": "application/yaml; charset=utf-8",
	".yml": "application/yaml; charset=utf-8",
	".toml": "application/toml; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".ts": "text/plain; charset=utf-8",
	".tsx": "text/plain; charset=utf-8",
	".py": "text/x-python; charset=utf-8",
	".go": "text/plain; charset=utf-8",
	".rs": "text/plain; charset=utf-8",
	".java": "text/x-java-source; charset=utf-8",
	".sh": "text/x-shellscript; charset=utf-8",
	".sql": "application/sql; charset=utf-8",
	".pdf": "application/pdf",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".heic": "image/heic",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".m4a": "audio/mp4",
	".ogg": "audio/ogg",
	".flac": "audio/flac",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mkv": "video/x-matroska",
	".zip": "application/zip",
	".gz": "application/gzip",
	".tgz": "application/gzip",
	".tar": "application/x-tar",
	".7z": "application/x-7z-compressed",
	".rar": "application/vnd.rar",
	".bin": "application/octet-stream",
}

export const DEFAULT_MIME = "application/octet-stream"

/** 只保留安全的扩展名，用于磁盘上的 code + ext 命名。 */
export function extensionFor(fileName: string): string {
	const ext = path.extname(fileName).toLowerCase()
	return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : ""
}

export function guessMimeType(fileName: string): string {
	return MIME_BY_EXTENSION[extensionFor(fileName)] ?? DEFAULT_MIME
}
