import { timingSafeEqual } from "node:crypto"
import path from "node:path"

export const HOUR_MS = 60 * 60 * 1000

export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min
	return Math.min(Math.max(value, min), max)
}

/** 去除目录、控制字符与非法符号，避免路径穿越与奇怪的展示名。 */
export function sanitizeFileName(input?: string | null): string {
	const raw = String(input ?? "")
		.trim()
		.replace(/\\/g, "/")
	const cleaned = path
		.basename(raw)
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/[<>:"|?*]/g, "_")
		.replace(/^\.+/, "")
		.trim()
	if (!cleaned) return "file"
	if (cleaned.length <= 200) return cleaned
	const ext = path.extname(cleaned).slice(0, 16)
	return `${cleaned.slice(0, 200 - ext.length)}${ext}`
}

export function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"]
	let value = Math.max(0, bytes)
	let unitIndex = 0
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024
		unitIndex += 1
	}
	const rendered = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(value >= 10 ? 1 : 2)
	return `${rendered} ${units[unitIndex]}`
}

/** 把小时数渲染成人读时长，例如 24 小时 / 30 分钟 / 7 天。 */
export function formatDuration(hours: number): string {
	if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`
	if (hours < 48) return `${Number(hours.toFixed(hours % 1 === 0 ? 0 : 1))} 小时`
	return `${Number((hours / 24).toFixed(1))} 天`
}

export function dedupeTags(tags: readonly string[]): string[] {
	const seen = new Map<string, string>()
	for (const candidate of tags) {
		const tag = String(candidate).trim().slice(0, 40)
		if (!tag) continue
		const key = tag.toLowerCase()
		if (!seen.has(key)) seen.set(key, tag)
	}
	return [...seen.values()].slice(0, 20)
}

export function parseTags(value?: string | string[] | null): string[] | undefined {
	if (value === undefined || value === null || value === "") return undefined
	const list = Array.isArray(value) ? value : value.split(",")
	const tags = dedupeTags(list)
	return tags.length > 0 ? tags : undefined
}

export function isTextualMime(mimeType: string): boolean {
	const type = mimeType.toLowerCase()
	if (type.startsWith("text/")) return true
	if (type.includes("+json") || type.includes("+xml")) return true
	return /^application\/(json|xml|yaml|toml|sql|javascript|x-ndjson|x-sh|x-shellscript)/.test(type)
}

export function normalizeMime(mimeType?: string | null): string | undefined {
	const value = mimeType?.trim()
	if (!value) return undefined
	// 浏览器 / curl 经常上报 octet-stream，此时优先用扩展名推断。
	if (value.toLowerCase() === "application/octet-stream") return undefined
	return value.slice(0, 120)
}

/** 同时给出 ASCII 回退与 RFC 5987 编码，保证中文文件名不乱码。 */
export function contentDisposition(fileName: string, type: "attachment" | "inline"): string {
	const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
	return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export function filenameFromContentDisposition(header?: string | null): string | undefined {
	if (!header) return undefined
	const encoded = /filename\*=(?:UTF-8|utf-8)''([^;]+)/i.exec(header)
	if (encoded?.[1]) {
		try {
			return decodeURIComponent(encoded[1].trim())
		} catch {
			/* 忽略非法编码，回退到 filename= */
		}
	}
	const plain = /filename="?([^";]+)"?/i.exec(header)
	return plain?.[1]?.trim()
}

export function timingSafeEquals(left: string, right: string): boolean {
	const a = Buffer.from(left)
	const b = Buffer.from(right)
	if (a.length !== b.length) return false
	return timingSafeEqual(a, b)
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
}
