// tools/lib/transform.mjs —— 构建期变换管线（唯一真源 _worker.js -> 产物）
//
// 变换分两类，性质完全不同：
//   · 值不变的：标识符改名、内部字段改名、明文拆分、剥离注释、空白收敛。
//     产物与源文件语义逐节点等价（由 check.mjs 用 AST 深比较证明）。
//   · 值会变的：字典值替换。会改变对外可见内容，必须在 rules.mjs 里显式声明。
//
// 关键安全设计：
//   · "属性键"（对象键 / .成员 / obj['x'] / defineProperty 键）构成保留命名空间，一律不改，
//     因此 KV 里的配置字段、HTTP 头名、订阅模板字段不会被动到。
//   · 内部字段（rules.mjs 点名）连属性键一起改，但必须先通过"该名字只以标识符形式出现"的不变量。
//   · 所有编辑都基于源文件偏移，最后一次性应用，并做区间重叠自检。
import { 解析, 遍历, 收集绑定名, 引号, 切分片段 } from './jsast.mjs';

const 内置全局 = [
	'globalThis', 'console', 'fetch', 'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'URLPattern',
	'Proxy', 'Reflect', 'Symbol', 'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'BigInt',
	'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise',
	'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Int8Array',
	'Int16Array', 'Int32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array',
	'TextEncoder', 'TextDecoder', 'crypto', 'WebSocketPair', 'WebSocket', 'atob', 'btoa',
	'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'structuredClone',
	'AbortController', 'AbortSignal', 'Blob', 'File', 'FormData', 'navigator', 'performance', 'self',
	'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent',
	'encodeURI', 'decodeURI', 'escape', 'unescape', 'Buffer', 'process', 'require', 'module', 'exports',
];

const 关键字 = new Set([
	'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
	'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
	'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return',
	'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
	'yield', 'await', 'arguments', 'eval',
]);

/** 属性键位置：这些名字属于"外部形状"，改了会破坏 KV/配置/协议契约 */
function 是属性键位置(父, 键) {
	if (!父) return false;
	switch (父.type) {
		case 'MemberExpression':
		case 'OptionalMemberExpression':
			return 键 === 'property' && !父.computed;
		case 'Property':
		case 'MethodDefinition':
		case 'PropertyDefinition':
			return 键 === 'key' && !父.computed;
		case 'ImportSpecifier':
			return 键 === 'imported';
		case 'ExportSpecifier':
			return 键 === 'exported' || 键 === 'local';
		default:
			return false;
	}
}

function 是标签位置(父, 键) {
	return !!父 && (父.type === 'LabeledStatement' || 父.type === 'BreakStatement' || 父.type === 'ContinueStatement') && 键 === 'label';
}

/** obj['x'] / Object.defineProperty(o, 'x', ...) —— 字符串键同样属于保留命名空间 */
function 吸收字符串键(父, 键, 下标, 值, 属性键) {
	if (值 === undefined) return;
	if ((父?.type === 'MemberExpression' || 父?.type === 'OptionalMemberExpression') && 键 === 'property' && 父.computed) {
		属性键.add(值);
		return;
	}
	if (父?.type === 'CallExpression' && 父.callee?.type === 'MemberExpression'
		&& 父.callee.object?.type === 'Identifier' && 父.callee.object.name === 'Object'
		&& 父.callee.property?.type === 'Identifier' && 父.callee.property.name === 'defineProperty' && 下标 === 1) {
		属性键.add(值);
	}
}

function 匹配替换(表, 值) {
	for (const 条 of 表 || []) {
		if (typeof 条.匹配 === 'string') { if (条.匹配 === 值 && typeof 条.替换 === 'string' && 条.替换 !== 值) return 条.替换; }
		else if (条.匹配 instanceof RegExp) { 条.匹配.lastIndex = 0; if (条.匹配.test(值) && typeof 条.替换 === 'string' && 条.替换 !== 值) return 条.替换; }
	}
	return null;
}

/** 生成未被占用的短名：池中按双射基数顺序取 a,b,...,z,A..Z,_,$ ,aa,ab... */
function 取短名(池, 序号) {
	let n = 序号 + 1, s = '';
	while (n > 0) { const r = (n - 1) % 池.length; s = 池[r] + s; n = Math.floor((n - 1) / 池.length); }
	return s;
}

function 行首表(文本) {
	const 表 = [0];
	for (let i = 0; i < 文本.length; i++) if (文本.charCodeAt(i) === 10) 表.push(i + 1);
	return 表;
}
function 定位行(表, 偏移) {
	let lo = 0, hi = 表.length - 1;
	while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (表[mid] <= 偏移) lo = mid; else hi = mid - 1; }
	return lo;
}

/** 名称是否"只以标识符形式出现"（不出现在任何字符串/模板/注释里）——严格模式的不变量 */
function 仅标识符出现(源码, 名, 区间) {
	const 排序 = [...区间].sort((a, b) => a[0] - b[0]);
	let k = 0, i = 0;
	for (;;) {
		i = 源码.indexOf(名, i);
		if (i < 0) return true;
		while (k < 排序.length && 排序[k][1] <= i) k++;
		if (!(k < 排序.length && 排序[k][0] === i && 排序[k][1] === i + 名.length)) return false;
		i += 名.length;
	}
}

/** 宽松模式的不变量：名字没有被当成"字符串键"使用（obj['x'] / Object.defineProperty(o,'x')） */
function 未当字符串键用(字符串键集, 名) {
	return !字符串键集.has(名);
}

/** 把 cooked 文本转义成可安全写回模板串的 raw 文本 */
function 转义模板(文本) {
	return 文本
		.replace(/\\/g, '\\\\')
		.replace(/`/g, '\\`')
		.replace(/\$\{/g, '\\${')
		.replace(/</g, '\\<');
}

/** 在一个 cooked 片段序列里找出所有拆分点，产出模板 raw 文本（用 ${'片段'} 插值藏起关键词） */
function 拆模板(cooked, 词表, 变体) {
	const 片 = 切分片段(cooked, 词表, 变体);
	if (!片) return null;
	// 片段必须各出现且仅出现一次：奇数片藏进插值，偶数片原样写出
	let out = 转义模板(片[0]);
	for (let i = 1; i < 片.length; i++) {
		out += (i % 2 === 1 ? '${' + 引号(片[i]) + '}' : 转义模板(片[i]));
	}
	return out;
}

/**
 * 执行整条管线。
 * @param {string} 源码 _worker.js 全文（不含 BOM）
 * @param {object} 规则 rules.mjs 导出的规则对象
 */
export function 变换(源码, 规则) {
	const { ast, 注释 } = 解析(源码);
	const 允许改名 = 规则.选项?.标识符改名 !== false;
	const 允许拆分 = 规则.选项?.明文拆分 !== false;
	// 穿透属性键：属性键位置本身永远不会被改名，但某个名字即使在别处也当过属性键，
	// 它作为"局部绑定"依然可以改名（改名只动绑定/引用位置，键名保持原样，语义不变）。
	// 关掉它更保守：凡是出现过属性键的名字一律保留，代价是指纹残留明显变多。
	const 穿透属性键 = 规则.选项?.改名穿透属性键 !== false;
	const 候选内部 = new Set(规则.内部字段 || []);

	// ── 第 0 步：内部字段不变量校验（在分类之前，校验不通过的名字直接剔除，不做任何改名）
	const 区间表 = new Map();
	if (候选内部.size) {
		遍历(ast, (n) => {
			if (n.type !== 'Identifier' || !候选内部.has(n.name)) return;
			if (!区间表.has(n.name)) 区间表.set(n.name, []);
			区间表.get(n.name).push([n.start, n.end]);
		});
	}
	const 内部字段 = new Set();
	const 内部字段违规 = [];
	const 内部字段提醒 = [];
	// 字符串键（obj['x'] / defineProperty(o,'x')）单独收集：这类才是真正会因改名而失效的用法
	const 字符串键集 = new Set();
	遍历(ast, (n, { 父, 键, 下标 }) => {
		if (n.type === 'Literal' && typeof n.value === 'string') 吸收字符串键(父, 键, 下标, n.value, 字符串键集);
	});
	const 严格校验 = 规则.选项?.内部字段严格校验 === true;
	for (const 名 of 候选内部) {
		const 区间 = 区间表.get(名) || [];
		if (!区间.length) { 内部字段违规.push(`${名}：源文件里没有这个标识符（规则表里的无效项）`); continue; }
		if (!未当字符串键用(字符串键集, 名)) {
			内部字段违规.push(`${名}：存在以字符串形式访问该键的写法（obj['${名}'] 之类），改键名会失效`);
			continue;
		}
		const 仅标识符 = 仅标识符出现(源码, 名, 区间);
		if (严格校验 && !仅标识符) {
			内部字段违规.push(`${名}：该名字同时出现在字符串/模板/注释里（严格模式禁止）`);
			continue;
		}
		if (!仅标识符) 内部字段提醒.push(`${名}：名字出现在字符串里（通常是日志/报错文案，已随拆分处理）；若其中含数据契约请移出内部字段`);
		内部字段.add(名);
	}

	// ── 第 1 步：分类
	const 属性键 = new Set();
	const 全部名 = new Set();
	const 标签集 = new Set();
	const 可改名 = [];
	const 简写点 = [];
	const 字符串点 = [];
	const 正则点 = [];
	const 模板点 = [];

	遍历(ast, (n, { 父, 键, 下标, 路径 }) => {
		switch (n.type) {
			case 'Identifier': {
				全部名.add(n.name);
				if (是标签位置(父, 键)) { 标签集.add(n.name); return; }
				if (父?.type === 'Property' && 父.shorthand === true) return; // 简写属性：key/value 同区间，统一由 简写点 处理
				// 简写属性带默认值时形如 { a = 1 }：左值的父节点是 AssignmentPattern，同样交给 简写点
				if (父?.type === 'AssignmentPattern' && 键 === 'left'
					&& 路径[路径.length - 2]?.type === 'Property' && 路径[路径.length - 2].shorthand === true) return;
				if (内部字段.has(n.name)) { 可改名.push({ 名: n.name, 起: n.start, 止: n.end }); return; }
				// 属性键位置永远不改（键名是对外形状）；是否因此连"同名绑定"也不改，由穿透开关决定
				if (是属性键位置(父, 键)) { 属性键.add(n.name); return; }
				可改名.push({ 名: n.name, 起: n.start, 止: n.end });
				return;
			}
			case 'Property': {
				if (n.shorthand === true && !n.computed && n.key.type === 'Identifier') {
					简写点.push({ 名: n.key.name, 起: n.key.start, 止: n.key.end });
				}
				return;
			}
			case 'Literal': {
				if (typeof n.value === 'string') {
					吸收字符串键(父, 键, 下标, n.value, 属性键);
					const 是键 = 键 === 'key' && (父?.type === 'Property' || 父?.type === 'MethodDefinition' || 父?.type === 'PropertyDefinition');
					字符串点.push({ 值: n.value, 起: n.start, 止: n.end, 是键 });
				} else if (n.regex) {
					正则点.push({ 模式: n.regex.pattern, 标志: n.regex.flags, 起: n.start, 止: n.end });
				}
				return;
			}
			case 'TemplateElement': {
				if (typeof n.value?.cooked === 'string') 模板点.push({ 值: n.value.cooked, 起: n.start, 止: n.end });
				return;
			}
			default: return;
		}
	});

	// 声明名（含函数参数、解构绑定）：只有"文件内自己声明过"的名字才允许改名，避免误改平台内置对象
	const 声明名 = new Set();
	遍历(ast, (n) => {
		switch (n.type) {
			case 'VariableDeclarator': 收集绑定名(n.id, 声明名); break;
			case 'FunctionDeclaration':
			case 'FunctionExpression':
				if (n.id) 声明名.add(n.id.name);
				for (const p of n.params || []) 收集绑定名(p, 声明名);
				break;
			case 'ClassDeclaration':
			case 'ClassExpression': if (n.id) 声明名.add(n.id.name); break;
			case 'CatchClause': 收集绑定名(n.param, 声明名); break;
			case 'ImportSpecifier': 声明名.add(n.local.name); break;
			default: break;
		}
	});

	// ── 第 2 步：生成改名映射
	const 出现点 = new Map();
	const 记出现 = (名, 起) => { const cur = 出现点.get(名); if (cur === undefined || 起 < cur) 出现点.set(名, 起); };
	for (const p of 可改名) 记出现(p.名, p.起);
	for (const p of 简写点) 记出现(p.名, p.起);

	const 映射 = new Map();
	if (允许改名) {
		const 保留 = new Set([
			...内置全局, ...关键字, ...(规则.保留标识符 || []), ...标签集, ...(规则.排除标识符 || []),
			...(穿透属性键 ? [] : 属性键),
		]);
		for (const [旧, 新] of Object.entries(规则.固定改名 || {})) if (!保留.has(旧)) 映射.set(旧, 新);
		// 内部字段不要求"文件内声明过"——它们往往只以属性键形式存在（要改的正是键本身）
		const 候选集 = new Set([...声明名, ...内部字段]);
		const 候选 = [...候选集]
			.filter(名 => !映射.has(名) && !保留.has(名) && 出现点.has(名))
			.sort((a, b) => 出现点.get(a) - 出现点.get(b));
		const 池 = 规则.名池 && 规则.名池.length ? 规则.名池 : 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
		const 已占 = new Set([...全部名, ...属性键, ...保留, ...关键字, ...映射.values()]);
		let 序号 = 0;
		for (const 名 of 候选) {
			let 新 = 取短名(池, 序号);
			while (已占.has(新) || 关键字.has(新)) 新 = 取短名(池, ++序号);
			序号++;
			映射.set(名, 新);
			已占.add(新);
		}
	}

	// ── 第 3 步：组装编辑
	const 编辑 = [];
	const 统计 = { 注释: 0, 标识符改名: 0, 内部字段改名: 0, 简写展开: 0, 字面量替换: 0, 字面量拆分: 0, 正则拆分: 0, 模板拆分: 0 };
	if (规则.选项?.剥离注释 !== false) {
		for (const c of 注释) { 编辑.push({ 起: c.起, 止: c.止, 文: c.类型 === '块' ? ' ' : '', 类: '注释' }); 统计.注释++; }
	}
	for (const p of 可改名) {
		const 新 = 映射.get(p.名);
		if (!新 || 新 === p.名) continue;
		编辑.push({ 起: p.起, 止: p.止, 文: 新, 类: 内部字段.has(p.名) ? '内部字段' : '标识符' });
		统计[内部字段.has(p.名) ? '内部字段改名' : '标识符改名']++;
	}
	for (const p of 简写点) {
		const 新 = 映射.get(p.名);
		if (!新 || 新 === p.名) continue;
		// 内部字段连键一起改；普通标识符只改绑定，键名保持原样（{a} -> {a: _x}）
		const 键 = 内部字段.has(p.名) ? 新 : p.名;
		编辑.push({ 起: p.起, 止: p.止, 文: `${键}: ${新}`, 类: '简写' });
		统计.简写展开++;
	}

	const 反向字面量 = new Map();
	const 保护字面量 = new Set(规则.保护字面量 || []);
	let 变体 = 0;
	for (const p of 字符串点) {
		if (p.是键 || 保护字面量.has(p.值)) continue;
		const 替 = 匹配替换(规则.字典值, p.值);
		if (替 !== null) {
			编辑.push({ 起: p.起, 止: p.止, 文: 引号(替), 类: '字面量替换' });
			反向字面量.set(替, p.值);
			统计.字面量替换++;
			continue;
		}
		if (!允许拆分) continue;
		const 片 = 切分片段(p.值, 规则.拆分关键词, 变体++);
		if (!片) continue;
		编辑.push({ 起: p.起, 止: p.止, 文: 片.map(引号).join(' + '), 类: '字面量拆分' });
		统计.字面量拆分++;
	}
	for (const p of 正则点) {
		if (!允许拆分) continue;
		const 片 = 切分片段(p.模式, 规则.拆分关键词, 变体++);
		if (!片) continue;
		编辑.push({ 起: p.起, 止: p.止, 文: 'new RegExp(' + 片.map(引号).join(' + ') + (p.标志 ? `, '${p.标志}'` : '') + ')', 类: '正则拆分' });
		统计.正则拆分++;
	}
	for (const p of 模板点) {
		if (!允许拆分) continue;
		const raw = 拆模板(p.值, 规则.拆分关键词, 变体++);
		if (!raw || raw === p.值) continue;
		编辑.push({ 起: p.起, 止: p.止, 文: raw, 类: '模板拆分' });
		统计.模板拆分++;
	}

	// 冲突自检：任何两段编辑不得重叠
	编辑.sort((a, b) => a.起 - b.起);
	for (let i = 1; i < 编辑.length; i++) {
		if (编辑[i].起 < 编辑[i - 1].止) {
			throw new Error(`编辑区间重叠：${编辑[i - 1].类}@${编辑[i - 1].起} 与 ${编辑[i].类}@${编辑[i].起}`);
		}
	}

	// ── 第 4 步：应用编辑
	let 代码 = '';
	let 游标 = 0;
	for (const e of 编辑) { 代码 += 源码.slice(游标, e.起) + e.文; 游标 = e.止; }
	代码 += 源码.slice(游标);

	// ── 第 5 步：空白收敛（跨行模板串内部原样保留，否则会改掉字符串值）
	// 偏移只能在编辑后的文本上重算，因此这里重新解析一次
	const 跨行模板 = [];
	try {
		遍历(解析(代码, { 收集注释: false }).ast, (n) => {
			if (n.type === 'TemplateLiteral' && 代码.slice(n.start, n.end).includes('\n')) 跨行模板.push({ 起: n.start, 止: n.end });
		});
	} catch (e) {
		throw new Error('变换后代码无法解析：' + e.message);
	}
	const 保护行 = new Set();
	if (跨行模板.length) {
		const 行表 = 行首表(代码);
		for (const t of 跨行模板) {
			const a = 定位行(行表, t.起), b = 定位行(行表, Math.max(t.起, t.止 - 1));
			for (let i = a; i <= b; i++) 保护行.add(i);
		}
	}
	const 输出 = [];
	代码.split('\n').forEach((行, i) => {
		if (保护行.has(i)) { 输出.push(行); return; }
		const t = 行.trim();
		if (t !== '') 输出.push(t);
	});
	代码 = 输出.join('\n');
	if (规则.产物头部) 代码 = 规则.产物头部 + '\n' + 代码;
	if (代码.length && !代码.endsWith('\n')) 代码 += '\n';

	const 反向标识符 = new Map([...映射].map(([旧, 新]) => [新, 旧]));
	统计.输入字节 = Buffer.byteLength(源码, 'utf8');
	统计.输出字节 = Buffer.byteLength(代码, 'utf8');
	统计.改名总数 = 映射.size;
	统计.属性键位置数 = 属性键.size;
	统计.标签数 = 标签集.size;
	统计.内部字段数 = 内部字段.size;
	统计.穿透属性键 = 穿透属性键;
	return { 代码, 统计, 映射, 反向标识符, 反向字面量, 内部字段违规, 内部字段提醒 };
}