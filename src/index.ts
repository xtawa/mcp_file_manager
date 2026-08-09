#!/usr/bin/env node
import type { Server } from "node:http"

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { loadConfig } from "./config.js"
import { createHttpApp } from "./http/app.js"
import { logger } from "./logger.js"
import { createMcpServer } from "./mcp/server.js"
import { startRetentionSweeper } from "./retention.js"
import { FileManagerService } from "./service.js"
import { formatBytes, formatDuration } from "./utils.js"
import { SERVICE_NAME, SERVICE_VERSION } from "./version.js"

type Options = {
	transport: "stdio" | "http"
	/** stdio 模式下是否同时拉起文件 HTTP 服务（不拉起则下载链接无人提供） */
	http: boolean
}

const USAGE = `${SERVICE_NAME} v${SERVICE_VERSION}

用法：
  mcp-file-manager [options]

选项：
  --transport <stdio|http>  stdio（默认）供 MCP 客户端拉起；http 供远程部署
  --no-http                 stdio 模式下不启动文件 HTTP 服务（不再对外提供下载链接）
  -h, --help                显示帮助
  -v, --version             显示版本

配置均通过环境变量读取，详见 .env.example。
`

function parseArgs(argv: string[]): Options {
	const options: Options = { transport: "stdio", http: true }
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		switch (arg) {
			case "--transport": {
				const value = argv[index + 1]
				if (value !== "stdio" && value !== "http") {
					throw new Error(`--transport 只支持 stdio 或 http，收到：${String(value)}`)
				}
				options.transport = value
				index += 1
				break
			}
			case "--no-http":
				options.http = false
				break
			case "-h":
			case "--help":
				process.stderr.write(USAGE)
				process.exit(0)
				break
			case "-v":
			case "--version":
				process.stderr.write(`${SERVICE_VERSION}\n`)
				process.exit(0)
				break
			default:
				if (arg !== undefined && arg.startsWith("-")) {
					throw new Error(`未知参数：${arg}`)
				}
		}
	}
	return options
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2))
	const config = loadConfig()
	const service = await FileManagerService.create(config)
	const sweeper = startRetentionSweeper(service, config.sweepIntervalMs)

	logger.info("服务初始化完成", {
		version: SERVICE_VERSION,
		dataDir: config.dataDir,
		retention: formatDuration(config.defaultTtlHours),
		maxUpload: formatBytes(config.maxUploadBytes),
		sweepEveryMinutes: Math.round(config.sweepIntervalMs / 60_000),
	})

	let httpServer: Server | undefined
	if (options.transport === "http" || options.http) {
		const app = createHttpApp(service)
		httpServer = app.listen(config.port, config.host, () => {
			logger.info("HTTP 服务已启动", {
				listening: `${config.host}:${config.port}`,
				publicBaseUrl: config.publicBaseUrl,
				mcpEndpoint: options.transport === "http" ? `${config.publicBaseUrl}/mcp` : undefined,
			})
		})
		const isLocalOnly = config.host === "127.0.0.1" || config.host === "localhost" || config.host === "::1"
		if (!config.apiToken && !isLocalOnly) {
			logger.warn("监听在非本地地址但未设置 FM_API_TOKEN，上传/删除/列表接口将完全开放", { host: config.host })
		}
	}

	if (options.transport === "stdio") {
		const mcpServer = createMcpServer(service)
		await mcpServer.connect(new StdioServerTransport())
		logger.info("MCP stdio 服务已就绪")
	}

	let shuttingDown = false
	const shutdown = (signal: string): void => {
		if (shuttingDown) return
		shuttingDown = true
		logger.info("正在关闭服务", { signal })
		sweeper.stop()
		httpServer?.close()
		setTimeout(() => process.exit(0), 300).unref()
	}
	process.on("SIGINT", () => shutdown("SIGINT"))
	process.on("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch((error: unknown) => {
	logger.error("启动失败", { error: (error as Error).message, stack: (error as Error).stack })
	process.exitCode = 1
})
