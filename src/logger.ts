export type LogLevel = "debug" | "info" | "warn" | "error"

const WEIGHTS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function currentLevel(): LogLevel {
	const raw = (process.env.FM_LOG_LEVEL ?? "info").trim().toLowerCase()
	return raw in WEIGHTS ? (raw as LogLevel) : "info"
}

/**
 * 日志一律写入 stderr。
 * stdio 传输下 stdout 是 MCP 的 JSON-RPC 通道，往 stdout 打印任何内容都会直接搞坏会话。
 */
function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
	if (WEIGHTS[level] < WEIGHTS[currentLevel()]) return
	const payload = { ts: new Date().toISOString(), level, message, ...meta }
	process.stderr.write(`${JSON.stringify(payload)}\n`)
}

export const logger = {
	debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
	info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
	warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
	error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
}
