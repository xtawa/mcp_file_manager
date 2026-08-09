import fs from "node:fs/promises"
import path from "node:path"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import { AppError, describeError } from "../errors.js"
import { logger } from "../logger.js"
import type { FileManagerService } from "../service.js"
import { formatBytes, formatDuration, isTextualMime } from "../utils.js"
import { SERVICE_NAME, SERVICE_VERSION } from "../version.js"

type ToolResult = {
	content: Array<{ type: "text"; text: string }>
	isError?: boolean
}

function ok(summary: string, payload: unknown): ToolResult {
	return {
		content: [{ type: "text", text: `${summary}\n\n${JSON.stringify(payload, null, 2)}` }],
	}
}

async function run(handler: () => Promise<ToolResult>): Promise<ToolResult> {
	try {
		return await handler()
	} catch (error) {
		logger.warn("MCP 工具执行失败", { error: describeError(error) })
		return { isError: true, content: [{ type: "text", text: describeError(error) }] }
	}
}

const codeArg = z
	.string()
	.min(4)
	.describe("上传时返回的标识码，大小写与连字符都可以，例如 7K2QF-9XM4T 或 7k2qf9xm4t")

/**
 * 创建一个 MCP Server 实例。stdio 与 HTTP 两种传输共用同一套工具定义。
 */
export function createMcpServer(service: FileManagerService): McpServer {
	const retention = formatDuration(service.config.defaultTtlHours)
	const server = new McpServer(
		{ name: SERVICE_NAME, version: SERVICE_VERSION },
		{
			instructions: [
				"文件中转服务：上传文件后会返回一个标识码（code）与可直接分享的下载链接。",
				`所有文件默认在 ${retention}后自动删除，请在回复用户时同时给出标识码、链接和到期时间。`,
				"后续需要再次取用同一个文件时，用 get_file_info / download_file 配合标识码查找，不要重复上传。",
				"需要让人类用户自己上传时，用 create_upload_link 生成一个浏览器上传页面链接。",
			].join("\n"),
		},
	)

	server.registerTool(
		"upload_file",
		{
			title: "上传文件",
			description: [
				"上传一个文件并获得标识码与下载链接。",
				"content / text / path / url 四个来源参数只能传其中一个：",
				"- content：base64 内容（二进制文件用这个）",
				"- text：纯文本内容",
				"- path：服务器本地文件路径",
				"- url：远程文件地址，由服务端抓取",
				`默认保留 ${retention}，到期自动删除；如需其他时长用 ttlHours。`,
			].join("\n"),
			inputSchema: {
				content: z.string().optional().describe("文件内容的 base64 编码，允许带 data URL 前缀"),
				text: z.string().optional().describe("直接上传的纯文本内容"),
				path: z.string().optional().describe("服务器可读的本地文件绝对路径"),
				url: z.string().optional().describe("http/https 远程文件地址"),
				name: z.string().optional().describe("文件名（建议带扩展名，例如 report.pdf）"),
				mimeType: z.string().optional().describe("内容类型，缺省根据扩展名推断"),
				description: z.string().optional().describe("备注，方便后续用 list_files 搜索"),
				tags: z.array(z.string()).optional().describe("标签，方便分类检索"),
				ttlHours: z.number().positive().optional().describe(`保留时长（小时），默认 ${service.config.defaultTtlHours}，上限 ${service.config.maxTtlHours}`),
				uploadedBy: z.string().optional().describe("上传者标识，例如用户名或 agent 名称"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
		},
		async (args) =>
			run(async () => {
				const sources = (
					[
						["content", args.content],
						["text", args.text],
						["path", args.path],
						["url", args.url],
					] as const
				).filter(([, value]) => value !== undefined && value !== "")

				if (sources.length === 0) {
					throw new AppError("invalid_input", "必须提供 content / text / path / url 中的一个")
				}
				if (sources.length > 1) {
					throw new AppError(
						"invalid_input",
						`只能提供一个来源参数，当前提供了：${sources.map(([key]) => key).join("、")}`,
					)
				}

				const meta = {
					name: args.name,
					mimeType: args.mimeType,
					description: args.description,
					tags: args.tags,
					ttlHours: args.ttlHours,
					uploadedBy: args.uploadedBy,
					source: "mcp" as const,
				}

				const [kind] = sources[0] as ["content" | "text" | "path" | "url", string]
				const view =
					kind === "content"
						? await service.saveFromBase64(args.content as string, meta)
						: kind === "text"
							? await service.saveFromText(args.text as string, meta)
							: kind === "path"
								? await service.saveFromLocalPath(args.path as string, meta)
								: await service.saveFromUrl(args.url as string, meta)

				return ok(
					`已上传 ${view.name}（${view.sizeHuman}）。标识码 ${view.codeFormatted}，${view.expiresIn}后自动删除。`,
					view,
				)
			}),
	)

	server.registerTool(
		"download_file",
		{
			title: "下载文件",
			description: [
				"根据标识码取回文件内容。",
				"默认自动选择编码：文本类直接返回正文，二进制返回 base64。",
				"传 savePath 可以直接写到服务器本地路径；文件过大时只返回链接。",
			].join("\n"),
			inputSchema: {
				code: codeArg,
				savePath: z.string().optional().describe("将内容写入这个本地路径，而不是内联返回"),
				encoding: z.enum(["auto", "utf-8", "base64", "none"]).optional().describe("none 表示只要元数据与链接"),
				maxInlineBytes: z.number().positive().optional().describe("内联返回的字节上限"),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args) =>
			run(async () => {
				const encoding = args.encoding ?? "auto"
				if (encoding === "none" && !args.savePath) {
					const view = service.info(args.code)
					return ok(`${view.name} 的元数据与下载链接。`, view)
				}

				const { record, buffer } = await service.readBuffer(args.code)
				await service.registerDownload(record.code)
				const view = service.toView(record)

				if (args.savePath) {
					const target = path.resolve(args.savePath)
					await fs.mkdir(path.dirname(target), { recursive: true })
					await fs.writeFile(target, buffer)
					return ok(`已将 ${view.name} 写入 ${target}。`, { ...view, savedTo: target })
				}

				const maxInline = args.maxInlineBytes ?? service.config.maxInlineDownloadBytes
				if (buffer.byteLength > maxInline) {
					return ok(
						`文件 ${view.sizeHuman} 超过内联返回上限 ${formatBytes(maxInline)}，请直接使用下载链接或传入 savePath。`,
						view,
					)
				}

				const useText = encoding === "utf-8" || (encoding === "auto" && isTextualMime(record.mimeType))
				return ok(`已取回 ${view.name}（${view.sizeHuman}）。`, {
					...view,
					encoding: useText ? "utf-8" : "base64",
					data: useText ? buffer.toString("utf8") : buffer.toString("base64"),
				})
			}),
	)

	server.registerTool(
		"get_file_info",
		{
			title: "查看文件信息",
			description: "根据标识码查看文件名、大小、校验值、下载链接与剩余保留时间，不返回文件内容。",
			inputSchema: { code: codeArg },
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args) =>
			run(async () => {
				const view = service.info(args.code)
				return ok(`${view.name}（${view.sizeHuman}），${view.expiresIn}后到期。`, view)
			}),
	)

	server.registerTool(
		"list_files",
		{
			title: "列出文件",
			description: "列出当前未过期的文件，支持关键词、标签过滤与分页。忘记标识码时用它找回文件。",
			inputSchema: {
				query: z.string().optional().describe("匹配文件名、备注、标签或标识码"),
				tag: z.string().optional().describe("按标签筛选"),
				limit: z.number().int().min(1).max(100).optional().describe("每页数量，默认 20"),
				offset: z.number().int().min(0).optional().describe("偏移量，默认 0"),
				sort: z.enum(["newest", "oldest", "expiring", "largest"]).optional().describe("排序方式，默认 newest"),
				includeExpired: z.boolean().optional().describe("是否包含已到期但尚未被清理的记录"),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async (args) =>
			run(async () => {
				const result = service.list(args)
				return ok(`共 ${result.total} 个文件，本页返回 ${result.files.length} 个。`, result)
			}),
	)

	server.registerTool(
		"delete_file",
		{
			title: "删除文件",
			description: "立即删除指定标识码的文件与元数据，不等到期。操作不可恢复。",
			inputSchema: { code: codeArg },
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async (args) =>
			run(async () => {
				const view = await service.remove(args.code)
				return ok(`已删除 ${view.name}（${view.codeFormatted}）。`, { code: view.code, name: view.name, deleted: true })
			}),
	)

	server.registerTool(
		"extend_expiry",
		{
			title: "延长保留时间",
			description: `把文件的到期时间重算为“从现在起再保留 N 小时”，上限 ${service.config.maxTtlHours} 小时。`,
			inputSchema: {
				code: codeArg,
				hours: z.number().positive().optional().describe(`新的保留时长（小时），缺省 ${service.config.defaultTtlHours}`),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (args) =>
			run(async () => {
				const view = await service.extend(args.code, args.hours)
				return ok(`${view.name} 的新到期时间：${view.expiresAt}（${view.expiresIn}后）。`, view)
			}),
	)

	server.registerTool(
		"create_upload_link",
		{
			title: "生成上传链接",
			description: [
				"生成一个临时上传页面链接，可以直接发给人类用户在浏览器里上传文件。",
				"用户上传完成后会得到标识码，把标识码告知你即可用 download_file 取用。",
			].join("\n"),
			inputSchema: {
				note: z.string().optional().describe("展示给上传者的说明，例如“请上传营业执照扫描件”"),
				expiresInMinutes: z.number().int().positive().optional().describe("链接有效期（分钟），默认 60"),
				maxUses: z.number().int().positive().optional().describe("最多可上传次数，默认 1"),
				fileTtlHours: z.number().positive().optional().describe(`通过该链接上传的文件保留时长（小时），默认 ${service.config.defaultTtlHours}`),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		async (args) =>
			run(async () => {
				const ticket = await service.createTicket(args)
				return ok(`上传链接已生成，有效期至 ${ticket.expiresAt}：${ticket.uploadUrl}`, ticket)
			}),
	)

	server.registerTool(
		"sweep_expired",
		{
			title: "立即清理到期文件",
			description: "手动触发一次到期清理（后台任务已经定时执行，一般无需调用）。",
			inputSchema: {},
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
		},
		async () =>
			run(async () => {
				const summary = await service.sweep()
				return ok(`已清理 ${summary.removedFiles} 个到期文件，释放 ${summary.reclaimedHuman}。`, summary)
			}),
	)

	server.registerTool(
		"get_storage_stats",
		{
			title: "查看存储状态",
			description: "查看当前文件数量、占用空间、保留策略与下一个到期时间。",
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		async () => run(async () => ok("当前存储状态。", service.stats())),
	)

	return server
}
