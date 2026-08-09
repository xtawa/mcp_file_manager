import { createReadStream, type ReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

const SAFE_STORED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/

/**
 * 文件实体存储。磁盘上的文件名由“标识码 + 白名单扩展名”组成，
 * 用户上传的原始文件名只存在元数据里，从根上消除路径穿越风险。
 */
export class BlobStorage {
	constructor(
		private readonly filesDir: string,
		private readonly tmpDir: string,
	) {}

	async init(): Promise<void> {
		await fs.mkdir(this.filesDir, { recursive: true })
		await fs.mkdir(this.tmpDir, { recursive: true })
		await this.clearTemp()
	}

	pathFor(storedName: string): string {
		if (!SAFE_STORED_NAME.test(storedName) || storedName.includes("..")) {
			throw new Error(`非法的存储文件名：${storedName}`)
		}
		return path.join(this.filesDir, storedName)
	}

	tempPath(): string {
		return path.join(this.tmpDir, `${randomUUID()}.part`)
	}

	async commit(tempPath: string, storedName: string): Promise<string> {
		const target = this.pathFor(storedName)
		await fs.rename(tempPath, target)
		return target
	}

	async remove(storedName: string): Promise<void> {
		await fs.rm(this.pathFor(storedName), { force: true })
	}

	createReadStream(storedName: string): ReadStream {
		return createReadStream(this.pathFor(storedName))
	}

	async readBuffer(storedName: string): Promise<Buffer> {
		return fs.readFile(this.pathFor(storedName))
	}

	async exists(storedName: string): Promise<boolean> {
		try {
			await fs.access(this.pathFor(storedName))
			return true
		} catch {
			return false
		}
	}

	async listBlobs(): Promise<string[]> {
		return fs.readdir(this.filesDir).catch(() => [])
	}

	/** 清理残留的上传分片（进程异常退出时可能产生）。 */
	async clearTemp(): Promise<void> {
		const entries = await fs.readdir(this.tmpDir).catch(() => [])
		await Promise.all(
			entries.map((entry) =>
				fs.rm(path.join(this.tmpDir, entry), { force: true, recursive: true }).catch(() => undefined),
			),
		)
	}
}
