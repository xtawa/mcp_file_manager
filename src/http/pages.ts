import { escapeHtml } from "../utils.js"

export type UploadPageOptions = {
	/** 表单提交地址 */
	action: string
	heading: string
	hint: string
	/** 默认保留时长描述，例如 "24 小时" */
	retention: string
	defaultTtlHours: number
	maxUpload: string
	requiresToken: boolean
	allowTtlOverride: boolean
}

const STYLES = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 16px; font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; background: #f6f7f9; color: #1f2328; }
main { max-width: 560px; margin: 0 auto; background: #fff; border: 1px solid #e3e5e8; border-radius: 12px; padding: 24px; }
h1 { margin: 0 0 8px; font-size: 20px; }
p.hint { margin: 0 0 20px; color: #656d76; }
label { display: block; margin-bottom: 14px; font-size: 13px; color: #424a53; }
input { display: block; width: 100%; margin-top: 6px; padding: 8px 10px; font-size: 14px; border: 1px solid #d0d7de; border-radius: 8px; background: #fff; color: inherit; }
input[type=file] { padding: 8px; background: #f6f7f9; }
button { width: 100%; padding: 10px 16px; font-size: 15px; font-weight: 600; color: #fff; background: #1f6feb; border: 0; border-radius: 8px; cursor: pointer; }
button:disabled { opacity: .6; cursor: progress; }
pre { margin: 18px 0 0; padding: 14px; background: #f6f7f9; border: 1px solid #e3e5e8; border-radius: 8px; white-space: pre-wrap; word-break: break-all; font-size: 13px; }
footer { max-width: 560px; margin: 14px auto 0; color: #8b949e; font-size: 12px; text-align: center; }
@media (prefers-color-scheme: dark) {
  body { background: #0d1117; color: #e6edf3; }
  main { background: #161b22; border-color: #30363d; }
  input, pre, input[type=file] { background: #0d1117; border-color: #30363d; color: #e6edf3; }
  p.hint, label, footer { color: #8b949e; }
}
`

/**
 * 人类用户的上传页面。没有任何前端构建步骤，一个自包含的 HTML 字符串。
 * 注意：页内脚本刷意避开模板字符串，以免与服务端的模板拼接相互干扰。
 */
export function renderUploadPage(options: UploadPageOptions): string {
	const tokenField = options.requiresToken
		? '<label>API Token<input name="token" type="password" autocomplete="off" required /></label>'
		: ""
	const ttlField = options.allowTtlOverride
		? `<label>保留时长（小时，可选，默认 ${options.defaultTtlHours}）<input name="ttlHours" type="number" min="1" step="1" placeholder="${options.defaultTtlHours}" /></label>`
		: ""

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(options.heading)}</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>${escapeHtml(options.heading)}</h1>
<p class="hint">${escapeHtml(options.hint)}</p>
<form id="upload-form">
<label>文件名（可选，缺省用原文件名）<input name="name" autocomplete="off" /></label>
<label>备注（可选）<input name="description" autocomplete="off" /></label>
<label>标签（可选，逗号分隔）<input name="tags" autocomplete="off" /></label>
${ttlField}
${tokenField}
<label>选择文件<input id="file-input" name="file" type="file" required /></label>
<button id="submit-button" type="submit">上传</button>
</form>
<pre id="result" hidden></pre>
</main>
<footer>单文件上限 ${escapeHtml(options.maxUpload)} · 文件保留 ${escapeHtml(options.retention)}后自动删除</footer>
<script>
var LF = String.fromCharCode(10);
var form = document.getElementById('upload-form');
var button = document.getElementById('submit-button');
var result = document.getElementById('result');
form.addEventListener('submit', function (event) {
  event.preventDefault();
  var data = new FormData(form);
  var token = data.get('token');
  data.delete('token');
  var headers = {};
  if (token) { headers['Authorization'] = 'Bearer ' + token; }
  button.disabled = true;
  result.hidden = false;
  result.textContent = '上传中…';
  fetch(${JSON.stringify(options.action)}, { method: 'POST', body: data, headers: headers })
    .then(function (response) {
      return response.json().then(function (payload) { return { ok: response.ok, status: response.status, payload: payload }; });
    })
    .then(function (outcome) {
      if (!outcome.ok) {
        var message = outcome.payload && outcome.payload.error ? outcome.payload.error.message : ('HTTP ' + outcome.status);
        result.textContent = '上传失败：' + message;
        return;
      }
      var file = outcome.payload;
      result.textContent = [
        '上传成功！把下面的标识码告知 AI 即可让它取用这个文件。',
        '标识码：' + file.codeFormatted,
        '下载链接：' + file.links.downloadUrl,
        '文件：' + file.name + '（' + file.sizeHuman + '）',
        '到期时间：' + file.expiresAt + '（' + file.expiresIn + '后）'
      ].join(LF);
      form.reset();
    })
    .catch(function (error) { result.textContent = '上传失败：' + error.message; })
    .then(function () { button.disabled = false; });
});
</script>
</body>
</html>`
}
