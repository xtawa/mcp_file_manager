export type AppErrorCode =
	| "invalid_input"
	| "unauthorized"
	| "not_found"
	| "expired"
	| "too_large"
	| "unsupported"
	| "internal_error"

/**
 * 业务异常：HTTP 层直接映射为状态码，MCP 层映射为 isError 结果。
 */
export class AppError extends Error {
	readonly code: AppErrorCode
	readonly httpStatus: number

	constructor(code: AppErrorCode, message: string, httpStatus = 400) {
		super(message)
		this.name = "AppError"
		this.code = code
		this.httpStatus = httpStatus
	}

	toJSON(): { code: AppErrorCode; message: string } {
		return { code: this.code, message: this.message }
	}
}

export function isAppError(value: unknown): value is AppError {
	return value instanceof AppError
}

export function describeError(error: unknown): string {
	if (isAppError(error)) return `${error.code}: ${error.message}`
	if (error instanceof Error) return `internal_error: ${error.message}`
	return `internal_error: ${String(error)}`
}
