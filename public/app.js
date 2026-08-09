"use strict"

/**
 * 上传页前端。无框架、无构建：/ 与 /u/:ticket 共用这份脚本，
 * 按路径自动切换成「一次性上传链接」模式。
 */

const HISTORY_KEY = "fm.history.v1"
const TOKEN_KEY = "fm.api.token"
const MAX_HISTORY = 20

const state = {
	config: null,
	uploadUrl: "/api/upload",
	ticketMode: false,
	ticketDone: false,
	files: [],
	busy: false,
}

/** 需要持续刷新「还剩多久」的节点 */
const countdowns = []

function el(id) {
	return document.getElementById(id)
}

function formatBytes(bytes) {
	if (!Number.isFinite(bytes)) return "-"
	const units = ["B", "KB", "MB", "GB"]
	let value = bytes
	let unit = 0
	while (value >= 1024 && unit < units.length - 1) {
		value = value / 1024
		unit = unit + 1
	}
	return value.toFixed(value < 10 && unit > 0 ? 1 : 0) + " " + units[unit]
}

function pad(input) {
	return String(input).padStart(2, "0")
}

function formatLocal(iso) {
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return String(iso)
	return (
		date.getFullYear() +
		"-" +
		pad(date.getMonth() + 1) +
		"-" +
		pad(date.getDate()) +
		" " +
		pad(date.getHours()) +
		":" +
		pad(date.getMinutes())
	)
}

function formatRemaining(iso) {
	const left = new Date(iso).getTime() - Date.now()
	if (!Number.isFinite(left)) return ""
	if (left <= 0) return "已过期，文件已被自动删除"
	const minutes = Math.floor(left / 60000)
	const hours = Math.floor(minutes / 60)
	const days = Math.floor(hours / 24)
	if (days >= 1) return "还剩 " + days + " 天 " + (hours % 24) + " 小时"
	if (hours >= 1) return "还剩 " + hours + " 小时 " + (minutes % 60) + " 分"
	if (minutes >= 1) return "还剩 " + minutes + " 分钟"
	return "不到 1 分钟"
}

function paintExpiry(entry) {
	entry.node.textContent = formatLocal(entry.expiresAt) + " · " + formatRemaining(entry.expiresAt)
	if (new Date(entry.expiresAt).getTime() <= Date.now()) entry.node.classList.add("expired")
}

function watchExpiry(node, expiresAt) {
	const entry = { node: node, expiresAt: expiresAt }
	countdowns.push(entry)
	paintExpiry(entry)
}

window.setInterval(function () {
	for (let index = countdowns.length - 1; index >= 0; index -= 1) {
		const entry = countdowns[index]
		if (!entry.node.isConnected) {
			countdowns.splice(index, 1)
			continue
		}
		paintExpiry(entry)
	}
}, 30000)

async function copyText(value) {
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(value)
			return true
		}
	} catch (error) {
		// 无权限时继续走兜底方案
	}
	const area = document.createElement("textarea")
	area.value = value
	area.setAttribute("readonly", "readonly")
	area.className = "offscreen"
	document.body.appendChild(area)
	area.select()
	let copied = false
	try {
		copied = document.execCommand("copy")
	} catch (error) {
		copied = false
	}
	document.body.removeChild(area)
	return copied
}

function flash(node, message) {
	node.hidden = false
	node.textContent = message
	window.setTimeout(function () {
		node.hidden = true
	}, 1800)
}

// ------------------------------------------------------------------ 本机历史

function readHistory() {
	try {
		const raw = window.localStorage.getItem(HISTORY_KEY)
		const list = raw ? JSON.parse(raw) : []
		if (!Array.isArray(list)) return []
		return list.filter(function (item) {
			return item && item.code && new Date(item.expiresAt).getTime() > Date.now()
		})
	} catch (error) {
		return []
	}
}

function writeHistory(list) {
	try {
		window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)))
	} catch (error) {
		// 隐私模式下写不进去，忽略即可
	}
}

function rememberFile(view) {
	const list = readHistory().filter(function (item) {
		return item.code !== view.code
	})
	list.unshift({
		code: view.code,
		codeFormatted: view.codeFormatted,
		name: view.name,
		sizeHuman: view.sizeHuman,
		expiresAt: view.expiresAt,
		downloadUrl: view.links.downloadUrl,
	})
	writeHistory(list)
	renderHistory()
}

function renderHistory() {
	const list = readHistory()
	const container = el("history-list")
	container.textContent = ""
	el("history-card").hidden = list.length === 0
	list.forEach(function (item) {
		const row = document.createElement("div")
		row.className = "history-row"

		const code = document.createElement("button")
		code.type = "button"
		code.className = "code small"
		code.title = "点击复制标识码"
		code.textContent = item.codeFormatted || item.code
		code.addEventListener("click", function () {
			const original = code.textContent
			void copyText(item.code).then(function (ok) {
				code.textContent = ok ? "已复制" : "复制失败"
				window.setTimeout(function () {
					code.textContent = original
				}, 1200)
			})
		})

		const name = document.createElement("span")
		name.className = "history-name"
		name.textContent = item.name + "（" + (item.sizeHuman || "") + "）"

		const expires = document.createElement("span")
		expires.className = "muted small"
		watchExpiry(expires, item.expiresAt)

		const link = document.createElement("a")
		link.className = "button ghost small"
		link.href = item.downloadUrl
		link.target = "_blank"
		link.rel = "noopener"
		link.textContent = "下载"

		row.append(code, name, expires, link)
		container.appendChild(row)
	})
}

// ------------------------------------------------------------------ 结果卡片

function buildCard(view) {
	const card = el("file-card-template").content.firstElementChild.cloneNode(true)
	const copied = card.querySelector("[data-copied]")
	const codeButton = card.querySelector("[data-code]")
	codeButton.textContent = view.codeFormatted || view.code
	codeButton.addEventListener("click", function () {
		void copyText(view.code).then(function (ok) {
			flash(copied, ok ? "已复制标识码" : "复制失败，请手动选择")
		})
	})

	card.querySelector("[data-name]").textContent = view.name
	card.querySelector("[data-size]").textContent = view.sizeHuman || formatBytes(view.size)
	watchExpiry(card.querySelector("[data-expires]"), view.expiresAt)

	card.querySelector("[data-download]").href = view.links.downloadUrl
	card.querySelector("[data-copy-link]").addEventListener("click", function () {
		void copyText(view.links.downloadUrl).then(function (ok) {
			flash(copied, ok ? "已复制下载链接" : "复制失败，请手动选择")
		})
	})
	card.querySelector("[data-copy-all]").addEventListener("click", function () {
		const lines = [
			"标识码：" + (view.codeFormatted || view.code),
			"文件：" + view.name + "（" + (view.sizeHuman || "") + "）",
			"下载：" + view.links.downloadUrl,
			"到期：" + view.expiresAt + "，" + view.expiresIn + "后自动删除",
		]
		void copyText(lines.join("\n")).then(function (ok) {
			flash(copied, ok ? "已复制，可直接发给 AI" : "复制失败，请手动选择")
		})
	})
	return card
}

function showResult(view) {
	el("results").hidden = false
	el("result-list").prepend(buildCard(view))
}

// ------------------------------------------------------------------ 待上传队列

function showError(message) {
	const node = el("upload-error")
	node.hidden = false
	node.textContent = message
}

function clearError() {
	el("upload-error").hidden = true
}

function showFatal(message) {
	const node = el("fatal")
	node.hidden = false
	node.textContent = message
}

function renderPending() {
	const list = el("pending-list")
	list.textContent = ""
	const empty = state.files.length === 0
	list.hidden = empty
	el("upload-button").disabled = empty || state.busy || state.ticketDone
	el("clear-button").hidden = empty || state.busy

	state.files.forEach(function (item) {
		const row = document.createElement("li")
		const head = document.createElement("div")
		head.className = "pending-head"

		const name = document.createElement("span")
		name.className = "pending-name"
		name.textContent = item.file.name

		const meta = document.createElement("span")
		meta.className = "muted small"
		meta.textContent = formatBytes(item.file.size) + " · " + item.status

		head.append(name, meta)

		const bar = document.createElement("div")
		bar.className = "bar"
		const fill = document.createElement("div")
		fill.className = item.failed ? "bar-fill failed" : "bar-fill"
		fill.style.width = Math.round(item.progress * 100) + "%"
		bar.appendChild(fill)

		row.append(head, bar)
		list.appendChild(row)
	})
}

function addFiles(fileList) {
	if (state.busy || state.ticketDone) return
	const limit = state.config && state.config.maxUploadBytes ? state.config.maxUploadBytes : 0
	const limitText = state.config && state.config.maxUploadHuman ? state.config.maxUploadHuman : formatBytes(limit)
	Array.prototype.slice.call(fileList).forEach(function (file) {
		if (file.size === 0) {
			showError(file.name + " 是空文件，服务端会拒绝")
			return
		}
		if (limit && file.size > limit) {
			showError(file.name + " 超过单文件上限 " + limitText)
			return
		}
		state.files.push({ file: file, progress: 0, status: "待上传", failed: false })
	})
	// 一次性链接每次只消费一个名额，只保留最后选中的文件
	if (state.ticketMode && state.files.length > 1) state.files = state.files.slice(-1)
	renderPending()
}

function collectMeta() {
	const meta = {}
	const description = el("description-input").value.trim()
	const tags = el("tags-input").value.trim()
	const ttlHours = el("ttl-input").value.trim()
	if (description) meta.description = description
	if (tags) meta.tags = tags
	if (ttlHours && !state.ticketMode) meta.ttlHours = ttlHours
	return meta
}

function uploadOne(item, meta) {
	return new Promise(function (resolve, reject) {
		const form = new FormData()
		Object.keys(meta).forEach(function (key) {
			form.append(key, meta[key])
		})
		form.append("file", item.file, item.file.name)

		const request = new XMLHttpRequest()
		request.open("POST", state.uploadUrl)
		const token = el("token-input").value.trim()
		if (token) request.setRequestHeader("Authorization", "Bearer " + token)

		request.upload.addEventListener("progress", function (event) {
			if (!event.lengthComputable) return
			item.progress = event.loaded / event.total
			item.status = "上传中 " + Math.round(item.progress * 100) + "%"
			renderPending()
		})
		request.addEventListener("load", function () {
			let payload = null
			try {
				payload = JSON.parse(request.responseText)
			} catch (error) {
				payload = null
			}
			if (request.status >= 200 && request.status < 300 && payload && payload.code) {
				resolve(payload)
				return
			}
			const message =
				payload && payload.error && payload.error.message ? payload.error.message : "HTTP " + request.status
			reject(new Error(message))
		})
		request.addEventListener("error", function () {
			reject(new Error("网络中断，上传失败"))
		})
		request.addEventListener("abort", function () {
			reject(new Error("上传已取消"))
		})
		request.send(form)
	})
}

async function runQueue() {
	if (state.busy || state.files.length === 0) return
	state.busy = true
	clearError()
	renderPending()

	const meta = collectMeta()
	for (const item of state.files) {
		item.status = "上传中"
		item.failed = false
		renderPending()
		try {
			const view = await uploadOne(item, meta)
			item.progress = 1
			item.status = "完成"
			showResult(view)
			rememberFile(view)
			if (state.ticketMode) state.ticketDone = true
		} catch (error) {
			item.failed = true
			item.status = "失败"
			showError(item.file.name + "：" + error.message)
		}
		renderPending()
	}

	state.busy = false
	// 成功的移出队列，失败的留下来可以直接重试
	state.files = state.files.filter(function (item) {
		return item.failed
	})
	renderPending()
	if (state.ticketDone) {
		el("dropzone").hidden = true
		el("page-hint").textContent = "上传完成。这个链接可能已用完，如需再传请向 AI 索要新链接。"
	}
}

// ------------------------------------------------------------------ 标识码查询

async function lookup() {
	const raw = el("lookup-input").value.trim()
	const status = el("lookup-status")
	const target = el("lookup-result")
	target.textContent = ""
	if (!raw) {
		flash(status, "请先输入标识码")
		return
	}
	status.hidden = false
	status.textContent = "查询中…"
	try {
		const response = await fetch("/api/files/" + encodeURIComponent(raw))
		const payload = await response.json()
		if (!response.ok) {
			throw new Error(payload && payload.error ? payload.error.message : "HTTP " + response.status)
		}
		status.hidden = true
		target.appendChild(buildCard(payload))
	} catch (error) {
		status.hidden = false
		status.textContent = "查不到：" + error.message
	}
}

// ------------------------------------------------------------------ 初始化

function applyConfig() {
	const config = state.config
	if (!config) return
	if (config.retention) {
		const badge = el("retention-badge")
		badge.hidden = false
		badge.textContent = "文件保留 " + config.retention + "后自动删除"
	}
	el("foot-limits").textContent =
		"单文件上限 " + (config.maxUploadHuman || "-") + " · 默认保留 " + (config.retention || "-")
	el("foot-version").textContent = (config.service || "mcp-file-manager") + " v" + (config.version || "")

	const ttl = el("ttl-input")
	if (config.defaultTtlHours) ttl.placeholder = String(config.defaultTtlHours)
	if (config.maxTtlHours) ttl.max = String(config.maxTtlHours)

	if (!config.requiresToken) return
	el("token-field").hidden = false
	try {
		const saved = window.sessionStorage.getItem(TOKEN_KEY)
		if (saved) el("token-input").value = saved
	} catch (error) {
		// 忽略
	}
}

function ticketFromPath() {
	const match = /^\/u\/([^/]+)/.exec(window.location.pathname)
	return match ? decodeURIComponent(match[1]) : ""
}

async function loadTicket(id) {
	state.ticketMode = true
	el("file-input").multiple = false
	el("token-field").hidden = true
	el("ttl-field").hidden = true
	try {
		const response = await fetch("/api/tickets/" + encodeURIComponent(id))
		const payload = await response.json()
		if (!response.ok) {
			throw new Error(payload && payload.error ? payload.error.message : "HTTP " + response.status)
		}
		state.uploadUrl = payload.uploadUrl
		el("page-title").textContent = "上传文件给 AI"
		el("page-hint").textContent = payload.note || "这是一个临时上传链接，上传后会显示标识码。"
		if (payload.retention) {
			const badge = el("retention-badge")
			badge.hidden = false
			badge.textContent = "文件保留 " + payload.retention + "后自动删除"
		}
	} catch (error) {
		state.ticketDone = true
		el("upload-card").hidden = true
		showFatal("这个上传链接不可用：" + error.message)
	}
}

function wireUi() {
	const dropzone = el("dropzone")
	const input = el("file-input")

	dropzone.addEventListener("click", function () {
		input.click()
	})
	dropzone.addEventListener("keydown", function (event) {
		if (event.key !== "Enter" && event.key !== " ") return
		event.preventDefault()
		input.click()
	})
	;["dragenter", "dragover"].forEach(function (name) {
		dropzone.addEventListener(name, function (event) {
			event.preventDefault()
			dropzone.classList.add("dragging")
		})
	})
	;["dragleave", "dragend"].forEach(function (name) {
		dropzone.addEventListener(name, function () {
			dropzone.classList.remove("dragging")
		})
	})
	dropzone.addEventListener("drop", function (event) {
		event.preventDefault()
		dropzone.classList.remove("dragging")
		if (event.dataTransfer && event.dataTransfer.files) addFiles(event.dataTransfer.files)
	})
	input.addEventListener("change", function () {
		addFiles(input.files)
		input.value = ""
	})
	document.addEventListener("paste", function (event) {
		if (!event.clipboardData || !event.clipboardData.files || event.clipboardData.files.length === 0) return
		addFiles(event.clipboardData.files)
	})

	el("upload-button").addEventListener("click", function () {
		void runQueue()
	})
	el("clear-button").addEventListener("click", function () {
		state.files = []
		clearError()
		renderPending()
	})
	el("lookup-button").addEventListener("click", function () {
		void lookup()
	})
	el("lookup-input").addEventListener("keydown", function (event) {
		if (event.key === "Enter") void lookup()
	})
	el("history-clear").addEventListener("click", function () {
		writeHistory([])
		renderHistory()
	})
	el("token-input").addEventListener("change", function () {
		try {
			window.sessionStorage.setItem(TOKEN_KEY, el("token-input").value.trim())
		} catch (error) {
			// 忽略
		}
	})
}

async function boot() {
	wireUi()
	try {
		const response = await fetch("/api/config")
		state.config = response.ok ? await response.json() : null
	} catch (error) {
		state.config = null
	}
	applyConfig()
	const ticket = ticketFromPath()
	if (ticket) await loadTicket(ticket)
	renderHistory()
	renderPending()
}

void boot()
