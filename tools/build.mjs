// tools/build.mjs —— 构建：_worker.js（唯一真源）-> dist/_worker.js（构建产物）
//
// 约定：
//   · 日常只改 _worker.js；dist/ 不入库、不手工编辑。
//   · 换字典值 / 换账号名 / 点名要改名的内部字段，一律改 tools/rules.mjs。
//   · 产物只是"去指纹后的等价代码"，真正的压缩交给 wrangler 的 minify。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 规则 from './rules.mjs';
import { 变换 } from './lib/transform.mjs';
import { 扫描, 渲染对比 } from './lib/scan.mjs';
import { 解析 } from './lib/jsast.mjs';

export const 根目录 = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const 源路径 = path.join(根目录, '_worker.js');
export const 产物路径 = path.join(根目录, 'dist', '_worker.js');

/** 读源文件并去掉 BOM */
export function 读源() {
	let 文本 = fs.readFileSync(源路径, 'utf8');
	const 带BOM = 文本.charCodeAt(0) === 0xFEFF;
	if (带BOM) 文本 = 文本.slice(1);
	return { 文本, 带BOM };
}

/** 在内存里跑一次完整构建（check.mjs 复用，保证两边同一套实现） */
export function 内存构建() {
	const 源 = 读源();
	const 结果 = 变换(源.文本, 规则);
	return { ...结果, 源文本: 源.文本, 带BOM: 源.带BOM };
}

function 千(n) { return n.toLocaleString('en-US'); }
function 字节(n) { return (n / 1024).toFixed(1) + ' KB'; }

/** 产物自检：必须仍是可解析的 ESM，且保留 Worker 入口 */
export function 校验产物(代码) {
	const { ast } = 解析(代码, { 收集注释: false });
	const 入口 = ast.body.find(n => n.type === 'ExportDefaultDeclaration');
	if (!入口) throw new Error('产物缺少 export default');
	const 目标 = 入口.declaration;
	const fetch方法 = (目标.type === 'ObjectExpression' ? 目标.properties : []).find(p => p.key?.name === 'fetch');
	if (!fetch方法) throw new Error('产物的 default 导出里没有 fetch 方法');
	return 入口;
}

function 主() {
	const 参数 = process.argv.slice(2);
	const 干跑 = 参数.includes('--dry') || 参数.includes('--dry-run');
	const 安静 = 参数.includes('--quiet');
	const t0 = Date.now();
	const r = 内存构建();
	校验产物(r.代码);
	const ms = Date.now() - t0;

	if (!干跑) {
		fs.mkdirSync(path.dirname(产物路径), { recursive: true });
		const 原 = fs.existsSync(产物路径) ? fs.readFileSync(产物路径, 'utf8') : null;
		if (原 !== r.代码) fs.writeFileSync(产物路径, r.代码, 'utf8');
	}

	if (!安静) {
		const s = r.统计;
		console.log('构建：_worker.js -> dist/_worker.js' + (干跑 ? '（干跑，未写盘）' : ''));
		console.log(`  源文件      ${千(s.输入字节)} 字符（${字节(s.输入字节)}${r.带BOM ? '，含 BOM' : ''}）`);
		console.log(`  产物        ${千(s.输出字节)} 字符（${字节(s.输出字节)}）`);
		console.log(`  剥离注释    ${千(s.注释)} 处`);
		console.log(`  标识符改名  ${千(s.标识符改名)} 处（内部字段 ${千(s.内部字段改名)} 处，简写展开 ${千(s.简写展开)} 处，共 ${千(s.改名总数)} 个名字）`);
		console.log(`  明文拆分    字面量 ${千(s.字面量拆分)} 处，正则 ${千(s.正则拆分)} 处`);
		console.log(`  字典值替换  ${千(s.字面量替换)} 处（会改变对外内容，逐条见下）`);
		console.log(`  属性键位置  ${千(s.属性键位置数)} 个名字（键本身不改，除非列入内部字段）；标签 ${千(s.标签数)} 个`);
		console.log(`  穿透属性键  ${s.穿透属性键 ? '开（同名绑定照改）' : '关（凡出现过属性键的名字一律保留）'}`);
		if (s.字面量替换) {
			console.log('\n  值变更明细（请确认这些是对外可见的）：');
			for (const [新, 旧] of r.反向字面量) console.log(`    ${JSON.stringify(旧)} -> ${JSON.stringify(新)}`);
		}
		if (r.内部字段违规.length) {
			console.log('\n  [警告] 内部字段改名不变量未满足：');
			for (const v of r.内部字段违规) console.log('    - ' + v);
			console.log('    （check.mjs 会因此判定失败）');
		}
		if (r.内部字段提醒.length) {
			console.log('\n  [提醒] 内部字段名字出现在字符串里（按"仅日志文案"处理）：');
			for (const v of r.内部字段提醒) console.log('    - ' + v);
		}
		const 源扫 = 扫描(r.源文本, 规则);
		const 产物扫 = 扫描(r.代码, 规则);
		console.log('\n特征对比（源文件 -> 产物）\n' + 渲染对比(源扫, 产物扫));
		console.log(`\n耗时 ${ms} ms`);
	}
	return r;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { 主(); } catch (e) { console.error('构建失败：' + e.message); process.exit(1); }
}