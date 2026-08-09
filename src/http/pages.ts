import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Response } from "express"

import { logger } from "../logger.js"

/**
 * 前端静态资源目录。src/http/ 与编译产物 dist/http/ 到仓库根都是两级，
 * 所以开发（tsx）与生产（node dist）可以共用同一段相对路径。
 */
export const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public")

/** 单页前端入口：/ 与 /u/:ticket 共用同一份 HTML，由前端按路径切换模式。 */
export const appPageFile = path.join(publicDir, "index.html")

/** 发送前端页面；资源缺失时给出可排查的提示，而不是一个空白的 500。 */
export function sendAppPage(res: Response): void {
	res.sendFile(appPageFile, (error?: Error) => {
		if (!error) return
		logger.error("前端页面发送失败", { file: appPageFile, error: error.message })
		if (res.headersSent) return
		res
			.status(500)
			.type("text/plain; charset=utf-8")
			.send("前端页面资源缺失：请确认部署时包含了仓库根目录下的 public/ 