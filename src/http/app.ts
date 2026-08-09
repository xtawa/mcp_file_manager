import busboy from "busboy"
import express, { type Express, type NextFunction, type Request, type Response } from "express"

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"

import { AppError, isAppError } from "../errors.js"
import { logger } from "../logger.js"
import { createMcpServer } from "../mcp/server.js"
import type { FileManagerService, FileView } from "../service.js"
import type { UploadSource } from "../store.js"
import { contentDisposition, formatBytes, formatDuration, parseTags, timingSafeEquals } from "../utils.js"
import { renderUploadPage } from "./pages.js"

/**
 * 接收 multipart/form-data 上传。文件流直接交给 service 写盘，
 * 不经过内存缓存，大文件也不会把进程撑爆。
 */
function receiveUpload(
	req: Request,
	service: FileManagerService,
	options: { source: UploadSource; ttlHours?: number },
): Promise<FileView> {
	return new Promise<FileView>((resolve, reject) => {
		let settled = false
		const settle = (error?: unknown, value?: FileView): void => {
			if (settled) return
			settled = true
			if (error) {
				reject(error)
				return
			}
			resolve(value as FileView)
		}

		let parser: ReturnType<typeof busboy>
		try {
			parser = busboy({ headers: req.headers, limits: { files: 1, fields: 24, fieldSize: 8 * 1024 } })
		} catch {
			settle(new AppError("invalid_input", "请求必须是 multipart/form-data，并包含名为 file 的文件字段"))
			return
		}

		const fields: Record<string, string> = {}
		let started = false

		parser.on("field", (name, value) => {
			fields[name] = value
		})

		parser.on("file", (_fieldName, stream, info) => {
			if (started) {
				stream.resume()
				return
			}
			started = true
			const requestedTtl = Number(fields.ttlHours)
			service
				.saveFromStream(stream, {
					source: options.source,
					name: fields.name || info.filename,
					mimeType: info.mimeType,
					description: fields.description,
					tags: parseTags(fields.tags),
					uploadedBy: fields.uploadedBy,
					ttlHours: Number.isFinite(requestedTtl) && requestedTtl > 0 ? requestedTtl : options.ttlHours,
				})
				.then(
					(view) => settle(undefined, view),
					(error: unknown) => {
						stream.resume()
						settle(error)
					},
				)
		})

		parser.on("filesLimit", () => settle(new AppError("invalid_input", "一次只能上传一个文件")))
		parser.on("error", (error: unknown) =>
			settle(new AppError("invalid_input", `解析上传内容失败：${(error as Error).message}`)),
		)
		parser.on("close", () => {
			if (!started) settle(new AppError("invalid_input", "请求中缺少名为 file 的文件字段"))
		})
		req.on("aborted", () => settle(new AppError("invalid_input", "上传已被客户端中断")))

		req.pipe(parser)
	})
}

export function createHttpApp(service: FileManagerService): Express {
	const app = express()
	const { config } = service
	const retention = formatDuration(config.defaultTtlHours)

	app.disable("x-powered-by")
	app.use((_req, res, next) => {
		res.setHeader("X-Content-Type-Options", "nosniff")
		res.setHeader("Referrer-Policy", "no-referrer")
		next()
	})

	/** 写接口鲁棒校验；未配置 FM_API_TOKEN 时不校验（仅适合本机）。 */
	const requireToken = (req: Request, res: Response, next: NextFunction): void => {
		const expected = config.apiToken
		if (!expected) {
			next()
			return
		}
		const header = req.get("authorization") ?? ""
		const bearer = /^bearer\s+(.+)$/i.exec(header)?.[1]?.trim()
		const queryToken = typeof req.query.token === "string" ? req.query.token : undefined
		const provided = bearer ?? req.get("x-api-token") ?? queryToken
		if (provided && timingSafeEquals(provided, expected)) {
			next()
			return
		}
		res.status(401).json({ error: { code: "unauthorized", message: "需要有效的 API Token" } })
	}

	// ---------------------------------------------------------------- 页面

	app.get("/", (_req, res) => {
		res.type("html").send(
			renderUploadPage({
				action: "/api/upload",
				heading: "文件上传",
				hint: `上传完成后会得到一个标识码与下载链接，把标识码告知 AI 即可让它取用文件。文件将在 ${retention}后自动删除。`,
				retention,
				defaultTtlHours: config.defaultTtlHours,
				maxUpload: formatBytes(config.maxUploadBytes),
				requiresToken: Boolean(config.apiToken),
				allowTtlOverride: true,
			}),
		)
	})

	app.get("/healthz", (_req, res) => {
		res.json({ status: "ok", service: "mcp-file-manager", retentionHours: config.defaultTtlHours })
	})

	// ---------------------------------------------------------------- 上传

	app.post("/api/upload", requireToken, (req, res, next) => {
		receiveUpload(req, service, { source: "http" })
			.then((view) => res.status(201).json(view))
			.catch(next)
	})

	// 一次性上传链接（由 MCP 工具 create_upload_link 生成，不需要 Token）
	app.get("/u/:ticket", (req, res, next) => {
		try {
			const ticket = service.requireTicket(req.params.ticket)
			res.type("html").send(
				renderUploadPage({
					action: `/u/${ticket.id}`,
					heading: "上传文件给 AI",
					hint: ticket.note ?? `这是一个临时上传链接，文件将在 ${formatDuration(ticket.fileTtlHours)}后自动删除。`,
					retention: formatDuration(ticket.fileTtlHours),
					defaultTtlHours: ticket.fileTtlHours,
					maxUpload: formatBytes(config.maxUploadBytes),
					requiresToken: false,
					allowTtlOverride: false,
				}),
			)
		} catch (error) {
			next(error)
		}
	})

	app.post("/u/:ticket", (req, res, next) => {
		let ticketId: string
		try {
			ticketId = service.requireTicket(req.params.ticket).id
		} catch (error) {
			next(error)
			return
		}
		const ticket = service.requireTicket(ticketId)
		receiveUpload(req, service, { source: "ticket", ttlHours: ticket.fileTtlHours })
			.then(async (view) => {
				await service.consumeTicket(ticketId)
				res.status(201).json(view)
			})
			.catch(next)
	})

	// ---------------------------------------------------------------- 下载与元数据

	const download = (req: Request, res: Response, next: NextFunction): void => {
		service
			.openDownload(req.params.code as string)
			.then(({ record, stream }) => {
				const disposition = req.query.inline === undefined ? "attachment" : "inline"
				res.setHeader("Content-Type", record.mimeType)
				res.setHeader("Content-Length", String(record.size))
				res.setHeader("Content-Disposition", contentDisposition(record.name, disposition))
				res.setHeader("ETag", `"${record.sha256}"`)
				res.setHeader("Cache-Control", "private, max-age=300")
				res.setHeader("X-File-Code", record.code)
				res.setHeader("X-File-Expires-At", record.expiresAt)

				stream.on("error", (error: Error) => {
					logger.error("读取文件失败", { code: record.code, error: error.message })
					res.destroy(error)
				})
				res.on("finish", () => void service.registerDownload(record.code).catch(() => undefined))
				stream.pipe(res)
			})
			.catch(next)
	}

	app.get("/f/:code", download)
	app.get("/f/:code/:filename", download)

	// 知道标识码就等于持有凭证，所以单文件元数据不再额外验证 Token。
	app.get("/api/files/:code", (req, res, next) => {
		try {
			res.json(service.info(req.params.code))
		} catch (error) {
			next(error)
		}
	})

	// 列表会泄露全部标识码，必须鲁棒。
	app.get("/api/files", requireToken, (req, res, next) => {
		try {
			res.json(
				service.list({
					query: typeof req.query.query === "string" ? req.query.query : undefined,
					tag: typeof req.query.tag === "string" ? req.query.tag : undefined,
					limit: req.query.limit ? Number(req.query.limit) : undefined,
					offset: req.query.offset ? Number(req.query.offset) : undefined,
					sort: typeof req.query.sort === "string" ? (req.query.sort as "newest") : undefined,
					includeExpired: req.query.includeExpired === "1",
				}),
			)
		} catch (error) {
			next(error)
		}
	})

	app.delete("/api/files/:code", requireToken, (req, res, next) => {
		service
			.remove(req.params.code)
			.then((view) => res.json({ deleted: true, code: view.code, name: view.name }))
			.catch(next)
	})

	app.post("/api/files/:code/extend", requireToken, express.json({ limit: "16kb" }), (req, res, next) => {
		const body = (req.body ?? {}) as { hours?: number }
		service
			.extend(req.params.code, body.hours)
			.then((view) => res.json(view))
			.catch(next)
	})

	app.get("/api/stats", requireToken, (_req, res) => {
		res.json(service.stats())
	})

	app.post("/api/sweep", requireToken, (_req, res, next) => {
		service
			.sweep()
			.then((summary) => res.json(summary))
			.catch(next)
	})

	// ---------------------------------------------------------------- MCP over HTTP

	/**
	 * 无状态 Streamable HTTP：每个请求一个全新的 server + transport，
	 * 适配 Serverless / 多实例部署，不需要会话亲和性。
	 */
	app.post("/mcp", requireToken, express.json({ limit: "8mb" }), async (req, res) => {
		const mcpServer = createMcpServer(service)
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		})
		res.on("close", () => {
			void transport.close()
			void mcpServer.close()
		})
		try {
			await mcpServer.connect(transport)
			await transport.handleRequest(req, res, req.body)
		} catch (error) {
			logger.error("MCP 请求处理失败", { error: (error as Error).message })
			if (!res.headersSent) {
				res.status(500).json({
					jsonrpc: "2.0",
					error: { code: -32603, message: "Internal server error" },
					id: null,
				})
			}
		}
	})

	app.all("/mcp", (_req, res) => {
		res.status(405).json({
			jsonrpc: "2.0",
			error: { code: -32000, message: "该端点只接受 POST（无状态 Streamable HTTP）" },
			id: null,
		})
	})

	// ---------------------------------------------------------------- 兼容与错误处理

	app.use((_req, res) => {
		res.status(404).json({ error: { code: "not_found", message: "接口不存在" } })
	})

	app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
		if (isAppError(error)) {
			res.status(error.httpStatus).json({ error: error.toJSON() })
			return
		}
		logger.error("未处理的请求错误", { error: (error as Error).message })
		res.status(500).json({ error: { code: "internal_error", message: "服务器内部错误" } })
	})

	return app
}
