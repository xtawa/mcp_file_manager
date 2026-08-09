import crypto from "node:crypto"
import { createReadStream, createWriteStream, type ReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ReadableStream as WebReadableStream } from "node:stream/web"

import { formatCode, generateCode, normalizeCode } from "./codes.js"
import type { Config } from "./config.js"
import { AppError } from "./errors.js"
import { logger } from "./logger.js"
import { extensionFor, guessMimeType } from "./mime.js"
import { BlobStorage } from "./storage.js"
import { MetadataStore, type FileRecord, type UploadSource, type UploadTicket } from "./store.js"
import {
	HOUR_MS,
	clamp,
	dedupeTags,
	filenameFromContentDisposition,
	formatBytes,
	formatDuration,
	normalizeMime,
	sanitizeFileName,
} from "./utils.js"

export type SaveMeta = {
	name?: string | undefined
	mimeType?: string | undefined
	description?: string | undefined
	tags?: string[] | undefined
	ttlHours?: number | undefined
	uploadedBy?: string | undefined
	source?: UploadSource | undefined
}

export type FileLinks = {
	/** 带文件名的下载链接，适合直接发给人 */
	downloadUrl: string
	/** 最短形式链接 */
	shortUrl: string
	/** 元数据 JSON 接口 */
	infoUrl: string
}

export type FileView = {
	code: string
	codeFormatted: string
	name: string
	size: number
	sizeHuman: string
	mimeType: string
	sha256: string
	createdAt: string
	expiresAt: string
	ttlHours: number
	expiresIn: string
	expiresInSeconds: number
	downloads: number
	source: UploadSource
	description?: string
	tags?: string[]
	uploadedBy?: string
	links: FileLinks
}

export type TicketView = {
	ticket: string
	uploadUrl: string
	createdAt: string
	expiresAt: string
	maxUses: number
	uses: number
	fileTtlHours: number
	note?: string
}

export type ListOptions = {
	query?: string | undefined
	tag?: string | undefined
	limit?: number | undefined
	offset?: number | undefined
	sort?: "newest" | "oldest" | "expiring" | "largest" | undefined
	includeExpired?: boolean | undefined
}

export type SweepSummary = {
	checkedAt: string
	removedFiles: number
	reclaimedBytes: number
	reclaimedHuman: string
	removedTickets: number
	removedOrphanBlobs: number
	remainingFiles: number
}

function isExpired(record: FileRecord, now = Date.now()): boolean {
	return new Date(record.expiresAt).getTime() <= now
}

/**
 * 文件中转服务的全部业务逻辑。MCP 层与 HTTP 层都只是它的两层薄封装，
 * 保证两边行为（标识码、链接、保留期）完全一致。
 */
export class FileManagerService {
	constructor(
		readonly config: Config,
		private readonly store: MetadataStore,
		private readonly storage: BlobStorage,
	) {}

	static async create(config: Config): Promise<FileManagerService> {
		const service = new FileManagerService(
			config,
			new MetadataStore(config.indexFile),
			new BlobStorage(config.filesDir, config.tmpDir),
		)
		await service.init()
		return service
	}

	async init(): Promise<void> {
		await this.storage.init()
		await this.store.load()
	}

	// ---------------------------------------------------------------- 上传

	/** 流式写入：边写盘边算 sha256 边计数，超限立即中断，不会把大文件读进内存。 */
	async saveFromStream(source: Readable, meta: SaveMeta = {}): Promise<FileView> {
		const name = sanitizeFileName(meta.name)
		const ttlHours = this.resolveTtlHours(meta.ttlHours)
		const code = this.allocateCode()
		const storedName = `${code}${extensionFor(name)}`
		const tempPath = this.storage.tempPath()
		const limit = this.config.maxUploadBytes
		const hash = crypto.createHash("sha256")
		let size = 0

		const meter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				size += chunk.length
				if (size > limit) {
					callback(new AppError("too_large", `文件超过单文件上限 ${formatBytes(limit)}`, 413))
					return
				}
				hash.update(chunk)
				callback(null, chunk)
			},
		})

		try {
			await pipeline(source, meter, createWriteStream(tempPath))
		} catch (error) {
			await fs.rm(tempPath, { force: true }).catch(() => undefined)
			if (error instanceof AppError) throw error
			throw new AppError("invalid_input", `接收文件失败：${(error as Error).message}`)
		}

		if (size === 0) {
			await fs.rm(tempPath, { force: true }).catch(() => undefined)
			throw new AppError("invalid_input", "文件内容为空，未保存")
		}

		await this.storage.commit(tempPath, storedName)

		const createdAt = new Date()
		const record: FileRecord = {
			code,
			name,
			storedName,
			mimeType: normalizeMime(meta.mimeType) ?? guessMimeType(name),
			size,
			sha256: hash.digest("hex"),
			createdAt: createdAt.toISOString(),
			expiresAt: new Date(createdAt.getTime() + ttlHours * HOUR_MS).toISOString(),
			ttlHours,
			downloads: 0,
			source: meta.source ?? "mcp",
			...(meta.description ? { description: meta.description.slice(0, 2000) } : {}),
			...(meta.tags && meta.tags.length > 0 ? { tags: dedupeTags(meta.tags) } : {}),
			...(meta.uploadedBy ? { uploadedBy: meta.uploadedBy.slice(0, 200) } : {}),
		}

		await this.store.putFile(record)
		logger.info("文件已保存", { code, name, size, ttlHours, source: record.source })
		return this.toView(record)
	}

	async saveFromBuffer(buffer: Buffer, meta: SaveMeta = {}): Promise<FileView> {
		return this.saveFromStream(Readable.from(buffer), meta)
	}

	async saveFromText(text: string, meta: SaveMeta = {}): Promise<FileView> {
		const name = meta.name ?? "note.txt"
		return this.saveFromBuffer(Buffer.from(text, "utf8"), { ...meta, name })
	}

	async saveFromBase64(base64: string, meta: SaveMeta = {}): Promise<FileView> {
		const cleaned = base64.replace(/^data:[^;,]*;base64,/i, "").replace(/\s+/g, "")
		if (cleaned === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
			throw new AppError("invalid_input", "content 不是合法的 base64 字符串")
		}
		return this.saveFromBuffer(Buffer.from(cleaned, "base64"), meta)
	}

	async saveFromLocalPath(localPath: string, meta: SaveMeta = {}): Promise<FileView> {
		if (!this.config.allowLocalPathUpload) {
			throw new AppError("unsupported", "服务端已禁用本地路径上传（FM_ALLOW_LOCAL_PATH=0）", 403)
		}
		const resolved = path.resolve(localPath)
		const stat = await fs.stat(resolved).catch(() => undefined)
		if (!stat) throw new AppError("not_found", `本地文件不存在：${resolved}`, 404)
		if (!stat.isFile()) throw new AppError("invalid_input", `不是一个普通文件：${resolved}`)
		if (stat.size > this.config.maxUploadBytes) {
			throw new AppError("too_large", `文件 ${formatBytes(stat.size)} 超过上限 ${formatBytes(this.config.maxUploadBytes)}`, 413)
		}
		return this.saveFromStream(createReadStream(resolved), { ...meta, name: meta.name ?? path.basename(resolved) })
	}

	async saveFromUrl(url: string, meta: SaveMeta = {}): Promise<FileView> {
		if (!this.config.allowRemoteFetch) {
			throw new AppError("unsupported", "服务端已禁用远程抓取（FM_ALLOW_REMOTE_FETCH=0）", 403)
		}
		let parsed: URL
		try {
			parsed = new URL(url)
		} catch {
			throw new AppError("invalid_input", `无法解析的 URL：${url}`)
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new AppError("invalid_input", "只支持 http / https 开头的 URL")
		}

		const response = await fetch(parsed, { redirect: "follow" }).catch((error: unknown) => {
			throw new AppError("invalid_input", `请求远程文件失败：${(error as Error).message}`)
		})
		if (!response.ok || !response.body) {
			throw new AppError("invalid_input", `下载远程文件失败：HTTP ${response.status} ${response.statusText}`)
		}
		const declaredSize = Number(response.headers.get("content-length") ?? "0")
		if (declaredSize > this.config.maxUploadBytes) {
			throw new AppError("too_large", `远程文件 ${formatBytes(declaredSize)} 超过上限 ${formatBytes(this.config.maxUploadBytes)}`, 413)
		}

		const headerName = filenameFromContentDisposition(response.headers.get("content-disposition"))
		const urlName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() ?? "")
		return this.saveFromStream(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), {
			...meta,
			name: meta.name ?? headerName ?? (urlName || "download"),
			mimeType: meta.mimeType ?? response.headers.get("content-type") ?? undefined,
		})
	}

	// ---------------------------------------------------------------- 读取

	/** 根据标识码取记录；已过期的记录会被顺手清理并抛 410。 */
	requireRecord(codeInput: string, options: { allowExpired?: boolean } = {}): FileRecord {
		const code = normalizeCode(String(codeInput ?? ""))
		if (!code) throw new AppError("invalid_input", "缺少标识码")
		const record = this.store.getFile(code)
		if (!record) {
			throw new AppError("not_found", `找不到标识码 ${formatCode(code)} 对应的文件，可能已被删除或已过期`, 404)
		}
		if (!options.allowExpired && isExpired(record)) {
			void this.remove(code).catch(() => undefined)
			throw new AppError(
				"expired",
				`文件已于 ${record.expiresAt} 到期并被自动删除（保留时长 ${formatDuration(record.ttlHours)}）`,
				410,
			)
		}
		return record
	}

	info(codeInput: string): FileView {
		return this.toView(this.requireRecord(codeInput))
	}

	async openDownload(codeInput: string): Promise<{ record: FileRecord; stream: ReadStream }> {
		const record = this.requireRecord(codeInput)
		if (!(await this.storage.exists(record.storedName))) {
			await this.remove(record.code).catch(() => undefined)
			throw new AppError("not_found", `文件实体丢失，已清理对应的元数据：${formatCode(record.code)}`, 404)
		}
		return { record, stream: this.storage.createReadStream(record.storedName) }
	}

	async readBuffer(codeInput: string): Promise<{ record: FileRecord; buffer: Buffer }> {
		const record = this.requireRecord(codeInput)
		try {
			return { record, buffer: await this.storage.readBuffer(record.storedName) }
		} catch {
			await this.remove(record.code).catch(() => undefined)
			throw new AppError("not_found", `文件实体丢失，已清理对应的元数据：${formatCode(record.code)}`, 404)
		}
	}

	async registerDownload(codeInput: string): Promise<void> {
		const code = normalizeCode(codeInput)
		const record = this.store.getFile(code)
		if (!record) return
		await this.store.patchFile(code, { downloads: record.downloads + 1 })
	}

	list(options: ListOptions = {}): { total: number; limit: number; offset: number; files: FileView[] } {
		const limit = Math.floor(clamp(options.limit ?? 20, 1, 100))
		const offset = Math.floor(clamp(options.offset ?? 0, 0, Number.MAX_SAFE_INTEGER))
		const keyword = options.query?.trim().toLowerCase()
		const tag = options.tag?.trim().toLowerCase()

		let items = this.store.listFiles()
		if (!options.includeExpired) items = items.filter((record) => !isExpired(record))
		if (tag) items = items.filter((record) => (record.tags ?? []).some((value) => value.toLowerCase() === tag))
		if (keyword) {
			items = items.filter((record) =>
				[record.name, record.code, record.description ?? "", ...(record.tags ?? [])]
					.join(" ")
					.toLowerCase()
					.includes(keyword),
			)
		}

		const sort = options.sort ?? "newest"
		items.sort((left, right) => {
			switch (sort) {
				case "oldest":
					return left.createdAt.localeCompare(right.createdAt)
				case "expiring":
					return left.expiresAt.localeCompare(right.expiresAt)
				case "largest":
					return right.size - left.size
				default:
					return right.createdAt.localeCompare(left.createdAt)
			}
		})

		return {
			total: items.length,
			limit,
			offset,
			files: items.slice(offset, offset + limit).map((record) => this.toView(record)),
		}
	}

	// ---------------------------------------------------------------- 写操作

	async remove(codeInput: string): Promise<FileView> {
		const code = normalizeCode(String(codeInput ?? ""))
		const record = await this.store.deleteFile(code)
		if (!record) {
			throw new AppError("not_found", `找不到标识码 ${formatCode(code)} 对应的文件`, 404)
		}
		await this.storage.remove(record.storedName).catch((error: unknown) => {
			logger.warn("删除文件实体失败", { code: record.code, error: (error as Error).message })
		})
		logger.info("文件已删除", { code: record.code })
		return this.toView(record)
	}

	/** 以“从现在开始再保留 N 小时”的语义重算到期时间。 */
	async extend(codeInput: string, hours?: number): Promise<FileView> {
		const record = this.requireRecord(codeInput)
		const ttlHours = this.resolveTtlHours(hours)
		const next = await this.store.patchFile(record.code, {
			ttlHours,
			expiresAt: new Date(Date.now() + ttlHours * HOUR_MS).toISOString(),
		})
		logger.info("已延长保留时长", { code: record.code, ttlHours })
		return this.toView(next ?? record)
	}

	// ---------------------------------------------------------------- 上传链接（给人类用户）

	async createTicket(input: {
		note?: string | undefined
		expiresInMinutes?: number | undefined
		maxUses?: number | undefined
		fileTtlHours?: number | undefined
	}): Promise<TicketView> {
		const expiresInMinutes = Math.floor(clamp(input.expiresInMinutes ?? 60, 1, 60 * 24 * 7))
		const ticket: UploadTicket = {
			id: generateCode(16),
			createdAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
			maxUses: Math.floor(clamp(input.maxUses ?? 1, 1, 100)),
			uses: 0,
			fileTtlHours: this.resolveTtlHours(input.fileTtlHours),
			...(input.note ? { note: input.note.slice(0, 500) } : {}),
		}
		await this.store.putTicket(ticket)
		logger.info("已创建上传链接", { ticket: ticket.id, expiresInMinutes })
		return this.toTicketView(ticket)
	}

	requireTicket(idInput: string): UploadTicket {
		const id = normalizeCode(String(idInput ?? ""))
		const ticket = this.store.getTicket(id)
		if (!ticket) throw new AppError("not_found", "上传链接无效或已失效", 404)
		if (new Date(ticket.expiresAt).getTime() <= Date.now()) {
			throw new AppError("expired", "上传链接已过期，请重新生成", 410)
		}
		if (ticket.uses >= ticket.maxUses) {
			throw new AppError("expired", `上传链接已达到使用上限（${ticket.maxUses} 次）`, 410)
		}
		return ticket
	}

	async consumeTicket(idInput: string): Promise<UploadTicket> {
		const ticket = this.requireTicket(idInput)
		const next = await this.store.patchTicket(ticket.id, { uses: ticket.uses + 1 })
		return next ?? ticket
	}

	// ---------------------------------------------------------------- 保留策略

	/**
	 * 清理到期文件（默认 24 小时）、失效上传链接，以及无主的文件实体。
	 * 同时在启动时、定时器到点时与手动调用 sweep_expired 时执行。
	 */
	async sweep(now: Date = new Date()): Promise<SweepSummary> {
		const timestamp = now.getTime()
		const expired = this.store.listFiles().filter((record) => isExpired(record, timestamp))
		let reclaimedBytes = 0

		for (const record of expired) {
			await this.store.deleteFile(record.code)
			await this.storage.remove(record.storedName).catch(() => undefined)
			reclaimedBytes += record.size
		}

		let removedTickets = 0
		for (const ticket of this.store.listTickets()) {
			const exhausted = ticket.uses >= ticket.maxUses
			const outdated = new Date(ticket.expiresAt).getTime() <= timestamp
			if (exhausted || outdated) {
				await this.store.deleteTicket(ticket.id)
				removedTickets += 1
			}
		}

		const known = new Set(this.store.listFiles().map((record) => record.storedName))
		const orphans = (await this.storage.listBlobs()).filter((blob) => !known.has(blob))
		for (const orphan of orphans) {
			await fs.rm(path.join(this.config.filesDir, orphan), { force: true }).catch(() => undefined)
		}

		const summary: SweepSummary = {
			checkedAt: now.toISOString(),
			removedFiles: expired.length,
			reclaimedBytes,
			reclaimedHuman: formatBytes(reclaimedBytes),
			removedTickets,
			removedOrphanBlobs: orphans.length,
			remainingFiles: this.store.listFiles().length,
		}
		if (expired.length > 0 || orphans.length > 0 || removedTickets > 0) {
			logger.info("到期清理完成", { ...summary })
		}
		return summary
	}

	stats(): Record<string, unknown> {
		const files = this.store.listFiles()
		const active = files.filter((record) => !isExpired(record))
		const totalBytes = active.reduce((sum, record) => sum + record.size, 0)
		const nextExpiry = active
			.map((record) => record.expiresAt)
			.sort((left, right) => left.localeCompare(right))[0]

		return {
			activeFiles: active.length,
			pendingCleanup: files.length - active.length,
			totalBytes,
			totalBytesHuman: formatBytes(totalBytes),
			totalDownloads: active.reduce((sum, record) => sum + record.downloads, 0),
			nextExpiryAt: nextExpiry ?? null,
			activeUploadTickets: this.store.listTickets().length,
			retentionPolicy: `默认保留 ${formatDuration(this.config.defaultTtlHours)}，到期后自动删除`,
			defaultTtlHours: this.config.defaultTtlHours,
			maxTtlHours: this.config.maxTtlHours,
			maxUploadSize: formatBytes(this.config.maxUploadBytes),
			sweepIntervalMinutes: Math.round(this.config.sweepIntervalMs / 60_000),
			publicBaseUrl: this.config.publicBaseUrl,
			dataDir: this.config.dataDir,
		}
	}

	// ---------------------------------------------------------------- 内部工具

	linksFor(record: FileRecord): FileLinks {
		const base = this.config.publicBaseUrl
		return {
			downloadUrl: `${base}/f/${record.code}/${encodeURIComponent(record.name)}`,
			shortUrl: `${base}/f/${record.code}`,
			infoUrl: `${base}/api/files/${record.code}`,
		}
	}

	toView(record: FileRecord): FileView {
		const remainingMs = new Date(record.expiresAt).getTime() - Date.now()
		return {
			code: record.code,
			codeFormatted: formatCode(record.code),
			name: record.name,
			size: record.size,
			sizeHuman: formatBytes(record.size),
			mimeType: record.mimeType,
			sha256: record.sha256,
			createdAt: record.createdAt,
			expiresAt: record.expiresAt,
			ttlHours: record.ttlHours,
			expiresIn: remainingMs <= 0 ? "已到期" : formatDuration(remainingMs / HOUR_MS),
			expiresInSeconds: Math.max(0, Math.round(remainingMs / 1000)),
			downloads: record.downloads,
			source: record.source,
			...(record.description ? { description: record.description } : {}),
			...(record.tags && record.tags.length > 0 ? { tags: record.tags } : {}),
			...(record.uploadedBy ? { uploadedBy: record.uploadedBy } : {}),
			links: this.linksFor(record),
		}
	}

	toTicketView(ticket: UploadTicket): TicketView {
		return {
			ticket: ticket.id,
			uploadUrl: `${this.config.publicBaseUrl}/u/${ticket.id}`,
			createdAt: ticket.createdAt,
			expiresAt: ticket.expiresAt,
			maxUses: ticket.maxUses,
			uses: ticket.uses,
			fileTtlHours: ticket.fileTtlHours,
			...(ticket.note ? { note: ticket.note } : {}),
		}
	}

	resolveTtlHours(requested?: number): number {
		if (requested === undefined || requested === null) return this.config.defaultTtlHours
		if (!Number.isFinite(requested) || requested <= 0) {
			throw new AppError("invalid_input", "ttlHours 必须是大于 0 的数字")
		}
		return Number(clamp(requested, 1 / 60, this.config.maxTtlHours).toFixed(4))
	}

	private allocateCode(): string {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			const code = generateCode()
			if (!this.store.getFile(code)) return code
		}
		throw new AppError("internal_error", "生成标识码失败，请重试", 500)
	}
}
