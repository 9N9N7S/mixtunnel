// tools/lib/scan.mjs —— Worker 特征扫描
// 口径与「Worker 特征检测报告」的分类对齐，用来做源文件 / 产物的量化对比。
import { 解析 } from './jsast.mjs';

function 行首表(文本) {
	const 表 = [0];
	for (let i = 0; i < 文本.length; i++) if (文本.charCodeAt(i) === 10) 表.push(i + 1);
	return 表;
}

function 定位行(表, 偏移) {
	let lo = 0, hi = 表.length - 1;
	while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (表[mid] <= 偏移) lo = mid; else hi = mid - 1; }
	return lo + 1;
}

function 全局正则(式) {
	return 式.flags.includes('g') ? 式 : new RegExp(式.source, 式.flags + 'g');
}

/**
 * 扫描文本中的特征命中。
 * @returns {{名:string, 级别:string, 次数:number, 行数:number, 行号:number[]}[]}
 */
export function 扫描(文本, 规则) {
	const 行表 = 行首表(文本);
	const 结果 = [];
	for (const 项 of 规则.特征扫描 || []) {
		let 次数 = 0;
		const 行号 = new Set();
		for (const 式 of 项.式) {
			const r = 全局正则(式);
			for (const m of 文本.matchAll(r)) {
				次数++;
				行号.add(定位行(行表, m.index));
			}
		}
		结果.push({ 名: 项.名, 级别: 项.级别, 次数, 行数: 行号.size, 行号: [...行号].sort((a, b) => a - b) });
	}
	// 原始标识符指纹（改名收益的量化）
	let 指纹次数 = 0;
	const 指纹行 = new Set();
	for (const 词 of 规则.指纹词 || []) {
		for (const m of 文本.matchAll(new RegExp('(?<![$A-Za-z0-9_\\u0080-\\uffff])' + 词.replace(/[$]/g, '\\$&') + '(?![$A-Za-z0-9_\\u0080-\\uffff])', 'g'))) {
			指纹次数++;
			指纹行.add(定位行(行表, m.index));
		}
	}
	结果.push({ 名: '原始标识符指纹', 级别: '高', 次数: 指纹次数, 行数: 指纹行.size, 行号: [...指纹行].sort((a, b) => a - b) });
	// 注释残留
	let 注释数 = 0;
	try { 注释数 = 解析(文本, { 收集注释: true }).注释.length; } catch { 注释数 = -1; }
	结果.push({ 名: '注释残留', 级别: '中', 次数: Math.max(注释数, 0), 行数: 0, 行号: [] });
	return 结果;
}

/** 并排渲染源文件与产物的对比表 */
export function 渲染对比(源结果, 产物结果) {
	const 表 = [['特征', '级别', '源文件', '产物', '变化']];
	const 索引 = new Map(产物结果.map(r => [r.名, r]));
	for (const r of 源结果) {
		const b = 索引.get(r.名);
		const 后 = b ? b.次数 : 0;
		const 变化 = 后 === r.次数 ? '持平' : (后 < r.次数 ? `-${r.次数 - 后}` : `+${后 - r.次数}`);
		表.push([r.名, r.级别, String(r.次数), String(后), 变化]);
	}
	const 列宽 = [0, 1, 2, 3, 4].map(i => Math.max(...表.map(row => [...row[i]].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0))));
	const 画线 = '─'.repeat(列宽.reduce((a, b) => a + b + 3, 1));
	const 行文本 = 表.map((row, ri) => row.map((cell, ci) => {
		const 宽 = [...cell].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
		return cell + ' '.repeat(Math.max(0, 列宽[ci] - 宽));
	}).join('  ') + (ri === 0 ? '  ← ' + 画线 : ''));
	return 行文本.join('\n');
}