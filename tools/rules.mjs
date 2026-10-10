// tools/rules.mjs —— 混淆规则表
//
// 这是构建期唯一需要你手工维护的文件：换字典值、换账号名、点名要连带改名的内部字段，都改这里。
// _worker.js 只写业务逻辑，不要往里塞"为了骗过检测"的手工拼接；那些由本表统一生成。
//
// 变换分两类，性质完全不同：
//   · 值不变的（明文拆分）：产物里看不到明文关键词，运行结果与源文件逐字节一致。
//   · 值会变的（字典值替换）：会改变对外可见内容（订阅、请求路径、账号名），改前请确认。

/** 各变换开关 */
export const 选项 = {
	剥离注释: true,      // 产物不含任何注释（注释里的中文说明也是指纹）
	标识符改名: true,      // 绑定/引用位置的标识符改成短名
	明文拆分: true,      // 把关键词字面量拆成 'tro' + 'jan' / new RegExp(...) 拼接
	改名穿透属性键: true,   // 某名字即使别处当过属性键，其"局部绑定"仍改名（键名本身永远不动）
	内部字段严格校验: false, // true = 内部字段的名字不得出现在任何字符串/模板/注释里
};

/** 产物首行横幅（会留下一条注释，介意扫描结果就置 null） */
export const 产物头部 = null;

/** 取名池：新名字按 a,b,...,z,A..Z,_,$ ,aa,ab... 顺序取，跳过源文件已占用的名字 */
export const 名池 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';

/** 额外保护标识符（平台内置 API 已由 transform.mjs 内置，这里只补项目自定义的） */
export const 保留标识符 = [
	// 需要与 KV / 前端页面 / 订阅模板保持一致的字段名，放这里可强制不改
];

/** 想保留可读性的标识符（不参与改名，留空表示全改） */
export const 排除标识符 = [];

/** 锁定某些名字：{ 原名: 指定新名 }，用于你希望稳定可查的入口 */
export const 固定改名 = {};

/** 保护字面量：这些字符串一律不替换、不拆分 */
export const 保护字面量 = ['use strict'];

/**
 * 字典值：会改变"值"。键=源文件里的字面量原文，值=产物里写入的字面量。
 * 值为 null 表示保持原样。改动前请自行确认对外契约。
 */
export const 字典值 = [
	// 示例：把伪装/登录页换成你自己的 Pages 站点（该站点需提供 /login 与 /noADMIN 两个页面）
	// { 匹配: 'https://edt-pages.github.io', 替换: 'https://你的域名.pages.dev' },
	// 示例：订阅备注里的项目名
	// { 匹配: 'edtunnel', 替换: '你的项目名' },
];

/**
 * 明文拆分：值完全不变，只把字面量切成拼接形式，让产物里不再出现连续明文。
 * 匹配方式为"子串包含"，因此可以只写关键词，不必写完整字面量。
 */
export const 拆分关键词 = [
	// —— 代理协议名 ——
	'trojan', 'Trojan', 'TROJAN',
	// —— 项目 / 站点标识 ——
	'edt-pages.github.io', 'github.com', 'v2rayN', 'tunnel',
	// —— 代理客户端名 ——
	'clash', 'Clash', 'mihomo', 'sing-box', 'singbox', 'Singbox', 'Surge', 'surge',
	'Loon', 'loon', 'quantumult', 'quanx', 'Shadowrocket', 'Stash', 'Happ',
	// —— 订阅转换后端 ——
	'subconverter', 'Subconverter', 'CF-Workers-SUB',
	// —— 请求头 / 路径 / 参数名 ——
	'sec-websocket-protocol', 'Upgrade', 'noADMIN', 'base64', 'b64',
	// —— DoH ——
	'cloudflare-dns.com', 'dns.alidns.com', 'doh.pub', 'dns.google',
	// —— 反代配置 ——
	'proxyIP', 'PROXYIP', 'proxyip', 'addressType',
	// —— 中文协议名（报告未列出，但同属特征）——
	'木马', '木马反代', '魏烈思',
];

/**
 * 内部字段：连属性键一起改名的字段白名单。
 * 与普通标识符改名的区别：普通改名会把 { rawClientData } 变成 { rawClientData: a }（键保留）；
 * 列入本表后，对象字面量键、.成员访问、解构键会一起改，产物里连这个词都不出现。
 * 安全前提（由 check.mjs 校验，不满足即报错）：该名字在源文件中只以标识符形式出现，
 * 一旦出现在字符串、模板或注释里（例如要写进订阅、KV JSON），就必须从这里移除。
 */
export const 内部字段 = [
	'rawClientData',
	'isUDP',
	'hasError',
	'respHeader',
	'addressType',
	'木马反代地址',
];

/**
 * 构建时间戳：源文件里形如 '2026-10-08 22:23:27' 的时间字面量，
 * 每次构建都替换成本次构建时间（产物第一行的 Version 就是它）。
 * 种子与时间戳都会记录进 dist/_worker.build.json，因此 check 仍能逐字节复现产物。
 */
export const 构建时间戳 = {
	启用: true,
	匹配: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
};

/**
 * 每次构建都换一套混淆：名池洗牌、短名起点、切点轮次、片段的引号风格与呈现方式都由种子决定，
 * 因此同一份 _worker.js 每次构建出的产物都不同，检测方无法用固定指纹跨版本比对。
 * 传 --seed <n> 可复现某一次构建；传 --seed 0 关闭随机化（产物固定，便于逐行比对）。
 */
export const 随机化 = {
	启用: true,
};

/** 特征扫描口径：与 Worker 特征检测报告的分类对齐，check.mjs 用来对比源文件与产物 */
export const 特征扫描 = [
	{ 名: 'Trojan 关键词', 级别: '严重', 式: [/trojan/gi] },
	{ 名: '已知项目/站点标识', 级别: '严重', 式: [/edt[-_.]?pages/gi, /github\.com\/[A-Za-z0-9_.-]+\//gi, /\bWSA?edge\b/gi] },
	{ 名: '代理客户端名称', 级别: '高', 式: [/clash/gi, /mihomo/gi, /sing-?box/gi, /surge/gi, /quantumult/gi, /quanx/gi, /\bloon\b/gi, /v2ray/gi, /shadowrocket/gi, /\bstash\b/gi, /\bhapp\b/gi, /sub-?converter/gi, /CF-Workers-SUB/gi] },
	{ 名: 'proxyIP 回源', 级别: '高', 式: [/proxyip/gi] },
	{ 名: '创建 WebSocketPair', 级别: '高', 式: [/WebSocketPair/g] },
	{ 名: 'early-data 头', 级别: '高', 式: [/sec-websocket-protocol/gi] },
	{ 名: 'websocket 升级判断', 级别: '中', 式: [/['"`]Upgrade['"`]/g] },
	{ 名: '中文协议名', 级别: '中', 式: [/木马/g, /魏烈思/g] },
	{ 名: '硬编码 UUID', 级别: '中', 式: [/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/g] },
	{ 名: '订阅接口', 级别: '中', 式: [/(?<![+\w])['"`](?:sub|token)['"`](?!\s*\+)/g] },
	{ 名: 'DoH / 公共 DNS', 级别: '中', 式: [/cloudflare-dns\.com/gi, /dns\.alidns\.com/gi, /doh\.pub/gi, /dns\.google/gi] },
	{ 名: '运行时 Base64', 级别: '中', 式: [/\batob\s*\(/g, /\bbtoa\s*\(/g, /fromCharCode/g] },
	{ 名: '53 端口 DNS 分支', 级别: '中', 式: [/\bport\s*[!=]==?\s*53\b/g] },
	{ 名: 'CF 常用端口列表', 级别: '中', 式: [/\b(?:2052|2053|2082|2083|2086|2087|2095|2096|8443)\b/g] },
	{ 名: '伪装站点 / 默认页', 级别: '中', 式: [/\/noADMIN/g] },
	{ 名: '凭据类环境变量', 级别: '低', 式: [/\b(?:ADMIN|PASSWORD|PSWD|TOKEN|UUID|KEY|PROXYIP|GO2SOCKS5)\b/g] },
	{ 名: '流式管道 API', 级别: '低', 式: [/\.pipeThrough\s*\(/g, /\w+\.pipeTo\s*\(/g] },
];

/** 原始标识符指纹：用来量化"改名到底干掉了多少"，取自特征检测报告的典型变量/函数名 */
export const 指纹词 = [
	'forwardataTCP', 'forwardataudp', 'connectStreams', 'isSpeedTestSite',
	'rawClientData', 'isUDP', 'respHeader', 'portRemote', 'remoteConnWrapper',
	'yourUUID', 'hasError', 'addressType', 'yourUUID', 'parsedSocks5',
];

const 规则 = {
	选项,
	产物头部,
	名池,
	保留标识符,
	排除标识符,
	固定改名,
	保护字面量,
	字典值,
	拆分关键词,
	内部字段,
	构建时间戳,
	随机化,
	特征扫描,
	指纹词,
};

export default 规则;