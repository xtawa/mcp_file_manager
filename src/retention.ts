import { logger } from "./logger.js"
import type { FileManagerService } from "./service.js"

export type Sweeper = { stop: () => void }

/**
 * 启动后台保留期守护：启动时先扫一次（进程停机期间到期的文件也会被清掉），
 * 之后每隔 FM_SWEEP_INTERVAL_MINUTES 分钟扫一次。
 */
export function startRetentionSweeper(service: FileManagerService, intervalMs: number): Sweeper {
	let stopped = false
	let running = false

	const runOnce = async (): Promise<void> => {
		if (stopped || running) return
		running = true
		try {
			await service.sweep()
		} catch (error) {
			logger.error("到期清理任务失败", { error: (error as Error).message })
		} finally {
			running = false
		}
	}

	void runOnce()
	const timer = setInterval(() => void runOnce(), intervalMs)
	// 不让定时器单独撑着进程：进程的生命周期由 stdio / HTTP 服务决定。
	timer.unref()

	return {
		stop: () => {
			stopped = true
			clearInterval(timer)
		},
	}
}
