// tools/lib/jsast.mjs —— JS 语法基础设施
// 职责：解析 / 遍历 / 常量折叠 / 归一化。
// build 与 check 共用同一套逻辑，保证"打脸"的不是同一份实现。
import { Parser } from 'acorn';

/** 归一化时忽略的节点自有键（位置与书写形式，不参与语义比较） */
export const 忽略键 = new Set(['type', 'start', 'end', 'loc', 'range', 'raw', 'regex', 'bigint']);

/**
 * 解析 ESM 源码。
 * @param {string} 代码
 * @param {{收集注释?: boolean}} 选项
 * @returns {{ast: object, 注释: Array<{类型:'行'|'块', 起:number, 止:number}>}}
 */
export function 解析(代码, { 收集注释 = true } = {}) {
	const 注释 = [];
	const ast = Parser.parse(代码, {
		ecmaVersion: 'latest',
		sourceType: 'module',
		allowReturnOutsideFunction: true,
		onComment: 收集注释 ? (isBlock, _text, start, end) => {
			注释.push({ 类型: isBlock ? '块' : '行', 起: start, 止: end });
		} : undefined,
	});
	return { ast, 注释 };
}

/**
 * 前序遍历。访问回调返回一个新节点可替换当前节点（用于常量折叠）。
 * 上下文 = { 父, 键, 下标, 路径 }；路径为可变栈，回调内不要长期持有。
 */
export function 遍历(根, 访问) {
	const 路径 = [];
	function 递归(节点, 父, 键, 下标) {
		if (!节点 || typeof 节点.type !== 'string') return;
		const 替换 = 访问(节点, { 父, 键, 下标, 路径 });
		const 当前 = 替换 && typeof 替换.type === 'string' ? 替换 : 节点;
		if (当前 !== 节点 && 父) {
			if (下标 !== undefined) 父[键][下标] = 当前;
			else 父[键] = 当前;
		}
		路径.push(当前);
		for (const k of Object.keys(当前)) {
			if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
			const v = 当前[k];
			if (Array.isArray(v)) {
				for (let i = 0; i < v.length; i++) 递归(v[i], 当前, k, i);
			} else if (v && typeof v.type === 'string') {
				递归(v, 当前, k, undefined);
			}
		}
		路径.pop();
	}
	递归(根, null, null, undefined);
}

/** 把绑定目标（Identifier / 解构模式 / 默认值 / 剩余元素）里的名字收集进集合 */
export function 收集绑定名(目标, 集合) {
	if (!目标) return 集合;
	switch (目标.type) {
		case 'Identifier': 集合.add(目标.name); break;
		case 'ObjectPattern':
			for (const 属性 of 目标.properties) 收集绑定名(属性.type === 'Property' ? 属性.value : 属性.argument, 集合);
			break;
		case 'ArrayPattern':
			for (const 元素 of 目标.elements) 收集绑定名(元素, 集合);
			break;
		case 'AssignmentPattern': 收集绑定名(目标.left, 集合); break;
		case 'RestElement': 收集绑定名(目标.argument, 集合); break;
		default: break;
	}
	return 集合;
}

/** 字符串字面量源码（保留原始书写形式） */
export function 引号(文本, 风格 = "'") {
	const 双引号 = 风格 === '"';
	return (双引号 ? '"' : "'") + 文本
		.replace(/\\/g, '\\\\')
		.replace(new RegExp(双引号 ? '"' : "'", 'g'), 双引号 ? '\\"' : "\\'")
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r') + (双引号 ? '"' : "'");
}

/** 判断切点是否落在正则转义序列内部（如 \x41、\d） */
export function 切点安全(模式, 位) {
	if (位 <= 0 || 位 >= 模式.length) return false;
	if (模式[位 - 1] === '\\') return false;
	if (位 >= 2 && /[0-9a-fA-F]/.test(模式[位 - 1]) && 模式[位 - 2] === '\\') return false;
	return true;
}

/**
 * 计算把 文本 按 目标 的每次出现切开后的片段数组（值不变，仅切分位置不同）。
 * 返回 null 表示"切不动"（未命中 / 切点不安全 / 片段仍含目标）。
 */
export function 切分片段(文本, 词表, 变体 = 0) {
	const 词集 = [...new Set((Array.isArray(词表) ? 词表 : [词表]).filter(w => typeof w === 'string' && w.length >= 2))];
	if (!词集.length) return null;
	// 收集全部关键词命中（长的优先；重叠只保留最长的那个）
	const 命中 = [];
	for (const 词 of [...词集].sort((a, b) => b.length - a.length)) {
		let from = 0;
		for (;;) {
			const i = 文本.indexOf(词, from);
			if (i < 0) break;
			命中.push({ 起: i, 止: i + 词.length, 词 });
			from = i + 词.length;
		}
	}
	if (!命中.length) return null;
	命中.sort((a, b) => a.起 - b.起 || b.止 - a.止);
	const 区间 = [];
	for (const h of 命中) {
		const 前 = 区间[区间.length - 1];
		if (前 && h.起 < 前.止) continue;
		区间.push(h);
	}

	// 每处命中切成 2~4 段：只切一刀会留下"半截明文"
	//（'edt-pages.github.io' 切成 'https://edt-pages.' + 'github.io' 仍能命中 edt-pages）。
	// 切点逐轮微调，直到所有片段都不含任何关键词（切在命中串之后会让校验失败，必须换轮）。
	for (let 轮 = 0; 轮 < 6; 轮++) {
		const 切点 = [];
		let 可行 = true;
		for (let idx = 0; idx < 区间.length && 可行; idx++) {
			const { 起: i, 词 } = 区间[idx];
			const 段数 = Math.min(4, 词.length);
			for (let k = 1; k < 段数; k++) {
				// 基点必定落在命中串内部；偏移只取 0/-1，保证不会切到串外或切在命中串之后
				const 基点 = i + Math.round((词.length * k) / 段数) - ((轮 + 变体 + idx + k) % 2);
				if (!切点安全(文本, 基点)) { 可行 = false; break; }
				切点.push(基点);
			}
		}
		if (!可行) continue;
		const 片段 = [];
		let 上 = 0;
		for (const p of 切点) {
			if (p <= 上) continue;
			片段.push(文本.slice(上, p));
			上 = p;
		}
		片段.push(文本.slice(上));
		const 有效 = 片段.filter(s => s !== '');
		if (有效.length >= 2 && !有效.some(s => 词集.some(w => s.includes(w)))) return 有效;
	}
	return null;
}

/** 后序常量折叠：字符串拼接、new RegExp(...)、globalThis['x'] */
function 折叠节点(节点) {
	for (const k of Object.keys(节点)) {
		if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
		const v = 节点[k];
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) {
				if (v[i] && typeof v[i].type === 'string') {
					const 替 = 折叠节点(v[i]);
					if (替 && typeof 替.type === 'string' && 替 !== v[i]) v[i] = 替;
				}
			}
		} else if (v && typeof v.type === 'string') {
			const 替 = 折叠节点(v);
			if (替 && typeof 替.type === 'string' && 替 !== v) 节点[k] = 替;
		}
	}
	if (节点.type === 'BinaryExpression' && 节点.operator === '+') {
		const 值 = 纯字符串(节点.left) !== null && 纯字符串(节点.right) !== null ? 纯字符串(节点.left) + 纯字符串(节点.right) : null;
		if (值 !== null) {
			return { type: 'Literal', value: 值, raw: undefined, start: 节点.start, end: 节点.end };
		}
	}
	if (节点.type === 'TemplateLiteral' && 节点.quasis.length === 节点.expressions.length + 1) {
		// 插值全是字符串字面量时，模板等价于字符串拼接，统一折叠成 Literal
		let 合并 = '', 合法 = true;
		for (let i = 0; i < 节点.quasis.length && 合法; i++) {
			const cooked = 节点.quasis[i].value.cooked;
			if (typeof cooked !== 'string') { 合法 = false; break; }
			合并 += cooked;
			if (i < 节点.expressions.length) {
				const e = 节点.expressions[i];
				if (e?.type === 'Literal' && typeof e.value === 'string') 合并 += e.value;
				else 合法 = false;
			}
		}
		if (合法) return { type: 'Literal', value: 合并, start: 节点.start, end: 节点.end };
	}
	if (节点.type === 'NewExpression' && 节点.callee?.type === 'Identifier' && 节点.callee.name === 'RegExp'
		&& 节点.arguments.length >= 1 && 节点.arguments.length <= 2
		&& 节点.arguments[0]?.type === 'Literal' && typeof 节点.arguments[0].value === 'string'
		&& (节点.arguments.length === 1 || (节点.arguments[1]?.type === 'Literal' && typeof 节点.arguments[1].value === 'string'))) {
		const flags = 节点.arguments[1]?.value ?? '';
		if (/^[dgimsuvy]*$/.test(flags)) {
			return { type: 'Literal', value: null, regex: { pattern: 节点.arguments[0].value, flags }, start: 节点.start, end: 节点.end };
		}
	}
	if (节点.type === 'MemberExpression' && 节点.computed && !节点.optional
		&& 节点.object?.type === 'Identifier' && 节点.object.name === 'globalThis'
		&& 节点.property?.type === 'Literal' && typeof 节点.property.value === 'string'
		&& /^[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*$/u.test(节点.property.value)) {
		return { type: 'Identifier', name: 节点.property.value, start: 节点.start, end: 节点.end };
	}
	return 节点;
}

/** 只认纯字符串字面量与无插值模板；出现任何表达式即返回 null（宁可不折，也不误折） */
function 纯字符串(节点) {
	if (!节点) return null;
	if (节点.type === 'Literal' && typeof 节点.value === 'string') return 节点.value;
	if (节点.type === 'TemplateLiteral' && 节点.expressions.length === 0 && 节点.quasis.length === 1) {
		return 节点.quasis[0].value.cooked;
	}
	return null;
}

/** 就地折叠整棵 AST；根节点可能被替换，故返回折叠结果 */
export function 折叠(根) {
	return 折叠节点(根);
}

/**
 * 归一化为可比较的纯数据树：抹掉位置信息、统一字面量与简写属性形态、
 * 反向还原标识符改名与字面量替换，使"源"与"产物"可直接深比较。
 */
export function 归一化(根, 反向 = { 标识符: new Map(), 字面量: new Map() }) {
	const 映标 = 反向.标识符 instanceof Map ? 反向.标识符 : new Map(Object.entries(反向.标识符 || {}));
	const 映字 = 反向.字面量 instanceof Map ? 反向.字面量 : new Map(Object.entries(反向.字面量 || {}));
	const 标 = name => 映标.get(name) ?? name;
	const 字 = value => 映字.get(value) ?? value;
	const 合并字符串叶 = 叶 => {
		const 合并 = [];
		for (const x of 叶) {
			const 末 = 合并[合并.length - 1];
			if (x.t === 's' && 末 && 末.t === 's') 合并[合并.length - 1] = { t: 's', v: 末.v + x.v };
			else 合并.push(x);
		}
		return 合并;
	};

	function 节点(n) {
		// 字符串拼接链与模板串统一规范成"与括号层数无关"的扁平序列：
		// 源文件写 `a${x}b`、产物写 'a' + x + 'b'（或插值多一处但字符串部分拼起来相同）时，
		// 语义一致但树形不同，归一后才能比较。
		if (n.type === 'BinaryExpression' && n.operator === '+') {
			const 叶 = [];
			const 推 = (x) => {
				if (x?.type === 'BinaryExpression' && x.operator === '+') { 推(x.left); 推(x.right); return; }
				叶.push(节点(x));
			};
			推(n);
			return { t: 'cat', ops: 合并字符串叶(叶) };
		}
		if (n.type === 'TemplateLiteral' && n.quasis.length === n.expressions.length + 1) {
			const 叶 = [];
			for (let i = 0; i < n.quasis.length; i++) {
				const cooked = n.quasis[i].value.cooked;
				叶.push(typeof cooked === 'string' ? { t: 's', v: cooked } : { t: '原样', v: n.quasis[i].value.raw });
				if (i < n.expressions.length) 叶.push(节点(n.expressions[i]));
			}
			return { t: 'cat', ops: 合并字符串叶(叶) };
		}
		switch (n.type) {
			case 'Identifier':
				return { t: 'id', n: 标(n.name) };
			case 'Literal': {
				if (n.regex) return { t: 're', p: n.regex.pattern, f: n.regex.flags };
				if (n.value instanceof RegExp) return { t: 're', p: n.value.source, f: n.value.flags };
				if (typeof n.value === 'string') return { t: 's', v: 字(n.value) };
				if (typeof n.value === 'bigint') return { t: 'big', v: String(n.value) };
				if (n.value === null) return { t: 'null' };
				if (n.value === undefined) return { t: 'undef' };
				return { t: 'num', v: String(n.value), neg: Object.is(n.value, -0) };
			}
			case 'Property': {
				const k = n.key;
				const 标识键 = !n.computed && k.type === 'Identifier';
				// {a} 与 {a: _x} 归一到同一形态（method/computed 显式写出，避免默认值差异）
				if (标识键 && n.value.type === 'Identifier' && 标(n.value.name) === 标(k.name)) {
					return { t: 'prop', kind: n.kind, method: false, computed: false, key: { t: 'key', n: 标(k.name) }, value: 节点(n.value) };
				}
				if (标识键 && n.value.type === 'AssignmentPattern' && n.value.left.type === 'Identifier' && 标(n.value.left.name) === 标(k.name)) {
					return { t: 'prop', kind: n.kind, method: false, computed: false, key: { t: 'key', n: 标(k.name) }, value: 节点(n.value) };
				}
				return {
					t: 'prop', kind: n.kind, method: !!n.method, computed: !!n.computed,
					key: 标识键 ? { t: 'key', n: 标(k.name) } : 节点(k),
					value: 节点(n.value),
				};
			}
			default: {
				const o = { t: n.type };
				for (const k of Object.keys(n).sort()) {
					if (忽略键.has(k)) continue;
					const v = n[k];
					if (Array.isArray(v)) o[k] = v.map(x => (x && typeof x.type === 'string' ? 节点(x) : x));
					else if (v && typeof v.type === 'string') o[k] = 节点(v);
					else if (v !== undefined) o[k] = v;
				}
				return o;
			}
		}
	}
	return 节点(折叠(根));
}

/** 深度优先比较两棵归一化树，返回第一处差异的路径描述（相同则返回 null） */
export function 首个差异(a, b, 路径 = '$') {
	if (a === b) return null;
	const 是对象 = x => x !== null && typeof x === 'object';
	if (!是对象(a) || !是对象(b)) return { 路径, 源: a, 产物: b };
	if (Array.isArray(a) !== Array.isArray(b)) return { 路径, 源: a, 产物: b };
	if (Array.isArray(a)) {
		if (a.length !== b.length) return { 路径: `${路径}.length`, 源: a.length, 产物: b.length };
		for (let i = 0; i < a.length; i++) {
			const d = 首个差异(a[i], b[i], `${路径}[${i}]`);
			if (d) return d;
		}
		return null;
	}
	const 键集 = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const k of 键集) {
		if (!(k in a)) return { 路径: `${路径}.${k}`, 源: '<缺失>', 产物: b[k] };
		if (!(k in b)) return { 路径: `${路径}.${k}`, 源: a[k], 产物: '<缺失>' };
		const d = 首个差异(a[k], b[k], `${路径}.${k}`);
		if (d) return d;
	}
	return null;
}