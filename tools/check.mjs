// tools/check.mjs —— 构建自检：证明"产物 == 源文件按规则变换后的结果"，且语义等价
//
// 五道关卡，任何一道不过都以非 0 退出：
//   1. 漂移检测：dist/_worker.js 与"用记录的种子+时间戳重建"的结果逐字节一致（证明没人手工编辑产物）。
//   2. 结构等价：两份 AST 各自归一化后逐节点深比较，只允许"规则表声明过的变换"存在差异。
//   3. 不变量：内部字段前提成立；产物无注释、无 BOM、无 debugger；时间戳与元数据一致。
//   4. 特征扫描：与源文件并排对比，量化去指纹效果。
//   5. 随机化：换一个种子重建，产物必须不同但依然等价（证明"每次构建都是新指纹"）。
import fs from 'node:fs';
import { 内存构建, 产物路径, 元数据路径, 读元数据, 校验产物, 哈希 } from './build.mjs';
import 规则 from './rules.mjs';
import { 解析, 归一化, 首个差异 } from './lib/jsast.mjs';
import { 扫描, 渲染对比 } from './lib/scan.mjs';

const 通过 = (名) => console.log(`  [通过] ${名}`);
const 失败 = (名, 说明) => { console.log(`  [失败] ${名}${说明 ? '：' + 说明 : ''}`); return 1; };
const 数 = n => n.toLocaleString('en-US');

let 问题 = 0;

console.log('自检：产物 vs 源文件\n');

// ── 1. 漂移检测 ─────────────────────────────────────────────
const 元 = 读元数据();
if (!元) {
	问题 += 失败('构建元数据', `缺少 ${元数据路径}，先跑 npm run build`);
} else {
	const r = 内存构建({ 种子: 元.seed, 时间戳: 元.timestamp });
	校验产物(r.代码);
	const 盘上 = fs.existsSync(产物路径) ? fs.readFileSync(产物路径, 'utf8') : null;
	if (盘上 === null) {
		问题 += 失败('产物存在性', 'dist/_worker.js 不存在，先跑 npm run build');
	} else if (盘上 !== r.代码) {
		问题 += 失败('产物漂移', `dist/_worker.js 与按元数据重建的结果不一致（${数(盘上.length)} vs ${数(r.代码.length)} 字符）：产物被手工改过，或 _worker.js/rules.mjs 改动后没重新构建`);
	} else if (元.artifactHash && 哈希(盘上) !== 元.artifactHash) {
		问题 += 失败('产物哈希', '元数据里的产物哈希与磁盘上的文件对不上');
	} else {
		通过(`产物与规则一致（种子 ${元.seed}，构建时间 ${元.timestamp}，${数(盘上.length)} 字符，哈希 ${哈希(盘上)}）`);
	}
	if (元.sourceHash) {
		const 源文本 = fs.readFileSync(new URL('../_worker.js', import.meta.url), 'utf8').replace(/^﻿/, '');
		if (哈希(源文本) !== 元.sourceHash) 失败('源文件已变更', '构建后 _worker.js 又被改过，请重新 npm run build');
	}

	// ── 2. 结构等价 ───────────────────────────────────────────
	const 源AST = 解析(r.源文本, { 收集注释: false }).ast;
	const 产AST = 解析(r.代码, { 收集注释: false }).ast;
	const 差异 = 首个差异(归一化(源AST), 归一化(产AST, { 标识符: r.反向标识符, 字面量: r.反向字面量 }));
	if (差异) {
		const 摘要 = v => (typeof v === 'object' ? JSON.stringify(v).slice(0, 160) : JSON.stringify(v));
		问题 += 失败('语义等价', `第一处差异 ${差异.路径}\n         源:   ${摘要(差异.源)}\n         产物: ${摘要(差异.产物)}`);
	} else {
		通过(`语义等价：${数(r.映射.size)} 个标识符改名、${数(r.反向字面量.size)} 处值替换、${数(r.统计.字面量拆分 + r.统计.正则拆分 + r.统计.模板拆分)} 处明文拆分均可逆`);
	}

	// ── 3. 不变量 ─────────────────────────────────────────────
	if (r.内部字段违规.length) {
		for (const v of r.内部字段违规) 问题 += 失败('内部字段改名前提', v);
	} else if (r.统计.内部字段数) {
		通过(`内部字段改名前提成立（${r.统计.内部字段数} 个字段可安全连带改名）`);
	} else {
		通过('未启用内部字段改名');
	}
	const 产注释 = 解析(r.代码, { 收集注释: true }).注释;
	if (产注释.length === 0) 通过('产物无注释残留');
	else 问题 += 失败('产物无注释残留', `仍有 ${产注释.length} 处注释`);
	if (!r.代码.startsWith('﻿')) 通过('产物无 BOM');
	else 问题 += 失败('产物无 BOM', '产物开头仍有 BOM');
	if (!/\bdebugger\b/.test(r.代码)) 通过('产物无 debugger 语句');
	else 问题 += 失败('产物无 debugger 语句', '存在 debugger');
	if (!规则.构建时间戳?.启用) 通过('未启用构建时间戳');
	else if (r.代码.includes(元.timestamp)) 通过(`构建时间戳已同步为 ${元.timestamp}`);
	else 问题 += 失败('构建时间戳', `产物里找不到 ${元.timestamp}，源文件里的 Version 可能没按规则改写`);

	// ── 5. 随机化：换种子后产物必须不同 ────────────────────────
	if (!元.seed) {
		通过('随机化已关闭（种子 0），产物固定');
	} else {
		const 别种子 = 元.seed ^ 0x5f3759df;
		const 别 = 内存构建({ 种子: 别种子, 时间戳: 元.timestamp });
		if (别.代码 === r.代码) {
			问题 += 失败('每次构建产物不同', '换一个种子重建得到了完全相同的产物，随机化没生效');
		} else {
			校验产物(别.代码);
			const 别差异 = 首个差异(归一化(源AST), 归一化(解析(别.代码, { 收集注释: false }).ast, { 标识符: 别.反向标识符, 字面量: 别.反向字面量 }));
			if (别差异) 问题 += 失败('换种子后仍语义等价', `第一处差异 ${别差异.路径}`);
			else 通过(`换种子 ${别种子} 产物不同且语义等价（每次构建都是新指纹）`);
		}
	}
}

// ── 4. 特征扫描 ─────────────────────────────────────────────
const r = 内存构建(元 ? { 种子: 元.seed, 时间戳: 元.timestamp } : {});
const 源扫 = 扫描(r.源文本, 规则);
const 产物扫 = 扫描(r.代码, 规则);
console.log('\n特征对比（源文件 -> 产物）\n' + 渲染对比(源扫, 产物扫));

const 变化项 = 源扫.map((s, i) => ({ 名: s.名, 前: s.次数, 后: 产物扫[i].次数 })).filter(x => x.后 > x.前);
if (变化项.length) {
	console.log('\n  注意：以下特征在产物中变多了，请检查规则：');
	for (const x of 变化项) console.log(`    - ${x.名}：${x.前} -> ${x.后}`);
	问题 += 失败('特征不增', 变化项.map(x => x.名).join('、'));
}

const 残留 = 产物扫.filter(x => x.次数 > 0 && x.级别 === '严重');
if (残留.length) {
	console.log('\n  仍存在的严重级特征（多为功能必需，无法在不改变行为的前提下去掉）：');
	for (const x of 残留) console.log(`    - ${x.名}：${x.次数} 处，行号 ${x.行号.slice(0, 12).join(',')}${x.行号.length > 12 ? ' …' : ''}`);
}

console.log(问题 === 0 ? '\n结论：全部通过' : `\n结论：${问题} 项未通过`);
process.exit(问题 === 0 ? 0 : 1);