import { randomInt } from "node:crypto"

/**
 * Crockford Base32：去掉了 I / L / O / U，避免人工抄写与 AI 转述时混淆。
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
export const CODE_LENGTH = 10
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{6,32}$/

export function generateCode(length: number = CODE_LENGTH): string {
	let code = ""
	for (let index = 0; index < length; index += 1) {
		code += ALPHABET.charAt(randomInt(ALPHABET.length))
	}
	return code
}

/**
 * 宽容地归一化标识码：忽略大小写、空白与连字符，并修正 I/L -> 1、O -> 0、U -> V 等常见误识。
 */
export function normalizeCode(input: string): string {
	return input
		.trim()
		.toUpperCase()
		.replace(/[\s\-_.]/g, "")
		.replace(/[IL]/g, "1")
		.replace(/O/g, "0")
		.replace(/U/g, "V")
}

export function isCodeShaped(code: string): boolean {
	return CODE_PATTERN.test(code)
}

/** 展示用分组格式，例如 7K2QF-9XM4T。存储与查询仍使用无连字符的原始形式。 */
export function formatCode(code: string): string {
	return (code.match(/.{1,5}/g) ?? [code]).join("-")
}
