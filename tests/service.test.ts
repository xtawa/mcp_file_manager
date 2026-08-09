import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"

import { formatCode, isCodeShaped, normalizeCode } from "../src/codes.js"
import { loadConfig, type Env } from "../src/config.js"
import { FileManagerService } from "../src/service.js"
import { HOUR_MS } from "../src/utils.js"

const tempDirs: string[] = []

async function createService(extra: Env = {}): Promise<{ service: FileManagerService; dir: string }> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fm-test-"))
	tempDirs.push(dir)
	const config = loadConfig({
		FM_DATA_DIR: dir,
		FM_PUBLIC_BASE_URL: "http://127.0.0.1:9999",
		FM_LOG_LEVEL: "error",
		...extra,
	})
	return { service: await FileManagerService.create(config), dir }
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("保留策略：默认 24 小时后自动删除", () => {
	it("新上传的文件保留时长为 24 小时", async () => {
		const { service } = await createService()
		const view = await service.saveFromText("你好，世界", { name: "hello.txt" })

		assert.equal(view.ttlHours, 24)
		assert.equal(
			new Date(view.expiresAt).getTime() - new Date(view.createdAt).getTime(),
			24 * HOUR_MS,
		)
		assert.equal(view.expiresIn, "24 小时")
	})

	it("23 小时时不删，25 小时时连文件实体一起清掉", async () => {
		const { service, dir } = await createService()
		const view = await service.saveFromText("到期测试", { name: "expiring.txt" })

		const early = await service.sweep(new Date(Date.now() + 23 * HOUR_MS))
		assert.equal(early.removedFiles, 0)
		assert.equal(service.info(view.code).code, view.code)

		const late = await service.sweep(new Date(Date.now() + 25 * HOUR_MS))
		assert.equal(late.removedFiles, 1)
		assert.equal(late.remainingFiles, 0)
		assert.throws(() => service.info(view.code), /找不到/)
		assert.deepEqual(await fs.readdir(path.join(dir, "files")), [])
	})

	it("extend_expiry 以“从现在起再保留 N 小时”重算到期时间", async () => {
		const { service } = await createService()
		const view = await service.saveFromText("延期测试", { name: "keep.txt" })

		const extended = await service.extend(view.code, 72)
		assert.equal(extended.ttlHours, 72)
		assert.ok(new Date(extended.expiresAt).getTime() > new Date(view.expiresAt).getTime())

		const summary = await service.sweep(new Date(Date.now() + 25 * HOUR_MS))
		assert.equal(summary.removedFiles, 0)
	})

	it("超过上限的 ttlHours 会被夹紧到 FM_MAX_TTL_HOURS", async () => {
		const { service } = await createService()
		const view = await service.saveFromText("x", { name: "x.txt", ttlHours: 99_999 })
		assert.equal(view.ttlHours, 720)
	})

	it("可以通过 FM_TTL_HOURS 改回 14 天", async () => {
		const { service } = await createService({ FM_TTL_HOURS: "336" })
		const view = await service.saveFromText("x", { name: "x.txt" })
		assert.equal(view.ttlHours, 336)
		assert.equal(view.expiresIn, "14 天")
	})
})

describe("标识码", () => {
	it("形状合法并带分组展示", async () => {
		const { service } = await createService()
		const view = await service.saveFromText("x", { name: "x.txt" })

		assert.ok(isCodeShaped(view.code))
		assert.equal(view.code.length, 10)
		assert.equal(view.codeFormatted, formatCode(view.code))
		assert.equal(normalizeCode(view.codeFormatted), view.code)
	})

	it("查找时宽容大小写、连字符与 0/O、1/l 混淆", async () => {
		const { service } = await createService()
		const view = await service.saveFromText("x", { name: "x.txt" })
		const messy = formatCode(view.code).toLowerCase().replace(/0/g, "o").replace(/1/g, "l")

		assert.equal(service.info(messy).code, view.code)
	})

	it("不存在的标识码报 404 语义错误", async () => {
		const { service } = await createService()
		assert.throws(
			() => service.info("ZZZZZZZZZZ"),
			(error: unknown) => (error as { httpStatus: number }).httpStatus === 404,
		)
	})
})

describe("上传与下载", () => {
	it("文本上传后可原样读回，下载次数累加", async () => {
		const { service } = await createService()
		const view = await service.saveFromText("报价：12800 元", { name: "quote.txt" })

		const { buffer } = await service.readBuffer(view.code)
		assert.equal(buffer.toString("utf8"), "报价：12800 元")

		await service.registerDownload(view.code)
		assert.equal(service.info(view.code).downloads, 1)
	})

	it("base64 上传会计算 sha256 并根据扩展名推断 MIME", async () => {
		const { service } = await createService()
		const view = await service.saveFromBase64(Buffer.from('{"ok":true}').toString("base64"), {
			name: "payload.json",
		})

		assert.equal(view.mimeType, "application/json; charset=utf-8")
		assert.equal(view.size, 11)
		assert.equal(view.sha256.length, 64)
	})

	it("非法 base64 与空文件都被拒绝", async () => {
		const { service } = await createService()
		await assert.rejects(() => service.saveFromBase64("这不是 base64！", { name: "a.bin" }), /base64/)
		await assert.rejects(() => service.saveFromBuffer(Buffer.alloc(0), { name: "empty.txt" }), /为空/)
	})

	it("超过单文件上限时报错，且不留下任何临时文件", async () => {
		const { service, dir } = await createService({ FM_MAX_UPLOAD_MB: "0.001" })

		await assert.rejects(
			() => service.saveFromBuffer(Buffer.alloc(5000, 7), { name: "big.bin" }),
			/上限/,
		)
		assert.deepEqual(await fs.readdir(path.join(dir, "files")), [])
		assert.deepEqual(await fs.readdir(path.join(dir, "tmp")), [])
	})

	it("生成的链接包含标识码与转义后的文件名", async () => {
		const { service } = await createService()
		const view = await service.saveFromText("x", { name: "月度 报告.txt" })

		assert.equal(view.links.shortUrl, `http://127.0.0.1:9999/f/${view.code}`)
		assert.equal(view.links.downloadUrl, `${view.links.shortUrl}/${encodeURIComponent("月度 报告.txt")}`)
		assert.equal(view.links.infoUrl, `http://127.0.0.1:9999/api/files/${view.code}`)
	})
})

describe("检索与管理", () => {
	it("list 支持关键词、标签与分页", async () => {
		const { service } = await createService()
		await service.saveFromText("一", { name: "报价单.txt", tags: ["财务"], description: "Q3 报价" })
		await service.saveFromText("二", { name: "readme.md", tags: ["文档"] })

		assert.equal(service.list({}).total, 2)
		assert.equal(service.list({ tag: "财务" }).total, 1)
		assert.equal(service.list({ query: "readme" }).files[0]?.name, "readme.md")
		assert.equal(service.list({ query: "Q3" }).total, 1)
		assert.equal(service.list({ limit: 1 }).files.length, 1)
	})

	it("delete_file 立即删除文件与元数据", async () => {
		const { service, dir } = await createService()
		const view = await service.saveFromText("x", { name: "x.txt" })

		await service.remove(view.code)
		assert.throws(() => service.info(view.code), /找不到/)
		assert.deepEqual(await fs.readdir(path.join(dir, "files")), [])
	})

	it("上传链接按次数失效，且继承 24 小时保留期", async () => {
		const { service } = await createService()
		const ticket = await service.createTicket({ maxUses: 1, note: "请上传扫描件" })

		assert.equal(ticket.fileTtlHours, 24)
		assert.ok(ticket.uploadUrl.endsWith(`/u/${ticket.ticket}`))
		assert.equal(service.requireTicket(ticket.ticket).note, "请上传扫描件")

		await service.consumeTicket(ticket.ticket)
		assert.throws(() => service.requireTicket(ticket.ticket), /上限/)
	})

	it("stats 展示当前保留策略", async () => {
		const { service } = await createService()
		await service.saveFromText("x", { name: "x.txt" })
		const stats = service.stats()

		assert.equal(stats.activeFiles, 1)
		assert.equal(stats.defaultTtlHours, 24)
		assert.match(String(stats.retentionPolicy), /24 小时/)
	})

	it("孤儿文件会在清理时被回收", async () => {
		const { service, dir } = await createService()
		await fs.writeFile(path.join(dir, "files", "ORPHAN0000.bin"), "leftover")

		const summary = await service.sweep()
		assert.equal(summary.removedOrphanBlobs, 1)
		assert.deepEqual(await fs.readdir(path.join(dir, "files")), [])
	})
})
