import fs from "node:fs/promises"
import path from "node:path"
import { logger } from "./logger.js"

export type UploadSource = "mcp" | "http" | "ticket"

export type FileRecord = {
	/** 供 AI / 用户查找的标识码（归一化后的形式） */
	code: string
	/** 展示用文件名 */
	name: string
	/** 磁盘上的文件名：code + 扩展名 */
	storedName: string
	mimeType: string
	size: number
	sha256: string
	createdAt: string
	expiresAt: string
	ttlHours: number
	downloads: number
	source: UploadSource
	description?: string
	tags?: string[]
	uploadedBy?: string
}

export type UploadTicket = {
	id: string
	createdAt: string
	expiresAt: string
	maxUses: number
	uses: number
	/** 通过该链接上传的文件的保留时长（小时） */
	fileTtlHours: number
	note?: string
}

type IndexShape = {
	version: number
	files: Record<string, FileRecord>
	tickets: Record<string, UploadTicket>
}

function emptyIndex(): IndexShape {
	return { version: 1, files: {}, tickets: {} }
}

/**
 * 单进程元数据索引：内存为真相，每次变更以“写临时文件 + rename”的方式原子落盘。
 * 写入串行排队，避免并发上传时互相覆盖。
 */
export class MetadataStore {
	private index: IndexShape = emptyIndex()
	private writeChain: Promise<void> = Promise.resolve()

	constructor(private readonly indexFile: string) {}

	async load(): Promise<void> {
		try {
			const raw = await fs.readFile(this.indexFile, "utf8")
			const parsed = JSON.parse(raw) as Partial<IndexShape>
			this.index = {
				version: parsed.version ?? 1,
				files: parsed.files ?? {},
				tickets: parsed.tickets ?? {},
			}
			logger.debug("元数据索引已加载", { files: Object.keys(this.index.files).length })
			return
		} catch (error) {
			const err = error as NodeJS.ErrnoException
			if (err.code === "ENOENT") {
				this.index = emptyIndex()
				await this.flush()
				return
			}
			const backup = `${this.indexFile}.corrupt-${Date.now()}`
			logger.error("元数据索引无法解析，已备份并重建", { backup, error: err.message })
			await fs.rename(this.indexFile, backup).catch(() => undefined)
			this.index = emptyIndex()
			await this.flush()
		}
	}

	getFile(code: string): FileRecord | undefined {
		return this.index.files[code]
	}

	listFiles(): FileRecord[] {
		return Object.values(this.index.files)
	}

	async putFile(record: FileRecord): Promise<FileRecord> {
		this.index.files[record.code] = record
		await this.flush()
		return record
	}

	async patchFile(code: string, patch: Partial<FileRecord>): Promise<FileRecord | undefined> {
		const current = this.index.files[code]
		if (!current) return undefined
		const next: FileRecord = { ...current, ...patch, code: current.code }
		this.index.files[code] = next
		await this.flush()
		return next
	}

	async deleteFile(code: string): Promise<FileRecord | undefined> {
		const current = this.index.files[code]
		if (!current) return undefined
		delete this.index.files[code]
		await this.flush()
		return current
	}

	getTicket(id: string): UploadTicket | undefined {
		return this.index.tickets[id]
	}

	listTickets(): UploadTicket[] {
		return Object.values(this.index.tickets)
	}

	async putTicket(ticket: UploadTicket): Promise<UploadTicket> {
		this.index.tickets[ticket.id] = ticket
		await this.flush()
		return ticket
	}

	async patchTicket(id: string, patch: Partial<UploadTicket>): Promise<UploadTicket | undefined> {
		const current = this.index.tickets[id]
		if (!current) return undefined
		const next: UploadTicket = { ...current, ...patch, id: current.id }
		this.index.tickets[id] = next
		await this.flush()
		return next
	}

	async deleteTicket(id: string): Promise<UploadTicket | undefined> {
		const current = this.index.tickets[id]
		if (!current) return undefined
		delete this.index.tickets[id]
		await this.flush()
		return current
	}

	private flush(): Promise<void> {
		const payload = JSON.stringify(this.index, null, 2)
		const task = this.writeChain.then(
			() => this.writeAtomic(payload),
			() => this.writeAtomic(payload),
		)
		// 保证队列不会因一次失败而断掉，同时把错误往上抛给当前调用方。
		this.writeChain = task.catch(() => undefined)
		return task
	}

	private async writeAtomic(payload: string): Promise<void> {
		await fs.mkdir(path.dirname(this.indexFile), { recursive: true })
		const tempFile = `${this.indexFile}.${process.pid}.tmp`
		await fs.writeFile(tempFile, payload, "utf8")
		await fs.rename(tempFile, this.indexFile)
	}
}
