import path from "node:path"

export type Env = Record<string, string | undefined>

export type Config = {
	/** 数据根目录 */
	dataDir: string
	/** 文件实体目录 */
	filesDir: string
	/** 上传中的临时分片目录 */
	tmpDir: string
	/** 元数据索引文件 */
	indexFile: string
	host: string
	port: number
	/** 用于拼接对外链接的基础地址（无尾部斜杠） */
	publicBaseUrl: string
	/** 默认保留时长（小时），默认 24 */
	defaultTtlHours: number
	/** 允许申请的最长保留时长（小时） */
	maxTtlHours: number
	maxUploadBytes: number
	maxInlineDownloadBytes: number
	apiToken?: string
	sweepIntervalMs: number
	allowRemoteFetch: boolean
	allowLocalPathUpload: boolean
}

const MB = 1024 * 1024

function readString(env: Env, key: string): string | undefined {
	const raw = env[key]
	if (raw === undefined) return undefined
	const trimmed = raw.trim()
	return trimmed === "" ? undefined : trimmed
}

function readNumber(env: Env, key: string, fallback: number): number {
	const raw = readString(env, key)
	if (raw === undefined) return fallback
	const value = Number(raw)
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`环境变量 ${key} 必须是大于 0 的数字，当前值："${raw}"`)
	}
	return value
}

function readBoolean(env: Env, key: string, fallback: boolean): boolean {
	const raw = readString(env, key)
	if (raw === undefined) return fallback
	return ["1", "true", "yes", "on"].includes(raw.toLowerCase())
}

export function loadConfig(env: Env = process.env): Config {
	const dataDir = path.resolve(readString(env, "FM_DATA_DIR") ?? "./data")
	const host = readString(env, "FM_HOST") ?? "127.0.0.1"
	const port = Math.floor(readNumber(env, "FM_PORT", 8787))
	const defaultTtlHours = readNumber(env, "FM_TTL_HOURS", 24)
	const maxTtlHours = Math.max(defaultTtlHours, readNumber(env, "FM_MAX_TTL_HOURS", 720))
	const displayHost = host === "0.0.0.0" || host === "::" ? "localhost" : host
	const fallbackBaseUrl = ["http:/", `/${displayHost}:${port}`].join("")
	const apiToken = readString(env, "FM_API_TOKEN")

	return {
		dataDir,
		filesDir: path.join(dataDir, "files"),
		tmpDir: path.join(dataDir, "tmp"),
		indexFile: path.join(dataDir, "index.json"),
		host,
		port,
		publicBaseUrl: (readString(env, "FM_PUBLIC_BASE_URL") ?? fallbackBaseUrl).replace(/\/+$/, ""),
		defaultTtlHours,
		maxTtlHours,
		maxUploadBytes: Math.floor(readNumber(env, "FM_MAX_UPLOAD_MB", 100) * MB),
		maxInlineDownloadBytes: Math.floor(readNumber(env, "FM_MAX_INLINE_MB", 4) * MB),
		...(apiToken ? { apiToken } : {}),
		sweepIntervalMs: Math.floor(readNumber(env, "FM_SWEEP_INTERVAL_MINUTES", 10) * 60_000),
		allowRemoteFetch: readBoolean(env, "FM_ALLOW_REMOTE_FETCH", true),
		allowLocalPathUpload: readBoolean(env, "FM_ALLOW_LOCAL_PATH", true),
	}
}
