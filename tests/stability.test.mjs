// 稳定性相关单测：日志裁剪、配置结构防御、CF 用量缓存、登录限流、超时 fetch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { 加载Worker模块 } from './helpers.mjs';

test('日志裁剪：线性算法守住字节上限且保留最新条目', async () => {
	const { 裁剪日志数组至字节上限 } = await 加载Worker模块();
	const 制造 = (条数, 每条字节) => Array.from({ length: 条数 }, (_, i) => ({ TYPE: 'Get_SUB', 序号: i, IP: 'x'.repeat(每条字节) }));
	const 小数组 = 制造(10, 100);
	assert.equal(裁剪日志数组至字节上限(小数组, 100000), 小数组); // 未超限原样返回
	const 大数组 = 制造(5000, 100);
	const 裁剪后 = 裁剪日志数组至字节上限(大数组, 200 * 1024);
	assert.ok(JSON.stringify(裁剪后, null, 2).length < 200 * 1024 + 4096, '裁剪后应接近上限');
	assert.ok(裁剪后.length < 大数组.length, '应有条目被丢弃');
	assert.equal(裁剪后[裁剪后.length - 1].序号, 大数组[大数组.length - 1].序号, '必须保留最新条目');
	assert.equal(裁剪日志数组至字节上限([], 1024).length, 0);
});

test('日志裁剪：最坏情况也要快（线性而非逐条全量序列化）', async () => {
	const { 裁剪日志数组至字节上限 } = await 加载Worker模块();
	const 数组 = Array.from({ length: 40000 }, (_, i) => ({ TYPE: 'Get_SUB', IP: '10.0.0.1', URL: '/sub?token=abcdefgh', UA: 'clash/1.0', TIME: 1700000000000 + i }));
	const 开始 = Date.now();
	const 裁剪后 = 裁剪日志数组至字节上限(数组, 4 * 1024 * 1024);
	const 耗时 = Date.now() - 开始;
	assert.ok(耗时 < 3000, `40000 条日志裁剪应在秒级完成，实际 ${耗时}ms`);
	assert.ok(JSON.stringify(裁剪后, null, 2).length < 4 * 1024 * 1024 + 8192);
});

test('配置结构防御：残缺/旧版配置不再抛异常', async () => {
	const { 确保配置结构 } = await 加载Worker模块();
	const 默认 = {
		HOST: 'h', HOSTS: ['h'], UUID: 'u', PATH: '/', 反代: { PROXYIP: 'auto', SOCKS5: { 启用: null, 账号: '' }, 路径模板: { PROXYIP: 'proxyip={{IP:PORT}}' } },
		订阅转换配置: { SUBLIST: false, EXPAND: true }, TG: { 启用: false }, CF: { Usage: { success: false } }, SS: { TLS: true }, 优选订阅生成: { SUBNAME: 'edge' + 'tunnel', 本地IP库: { 随机数量: 16 } },
	};
	const 残缺 = { HOST: 'h', 反代: { 路径模板: {} } };
	const 补齐 = 确保配置结构(JSON.parse(JSON.stringify(残缺)), 默认);
	assert.equal(补齐.反代.PROXYIP, 'auto');
	assert.equal(补齐.反代.SOCKS5.启用, null);
	assert.equal(补齐.反代.路径模板.PROXYIP, 'proxyip={{IP:PORT}}');
	assert.equal(补齐.订阅转换配置.EXPAND, true);
	assert.equal(补齐.SS.TLS, true);
	assert.equal(补齐.优选订阅生成.本地IP库.随机数量, 16);
	// 反代是普通对象 / SOCKS5 是非字符串都不应炸
	assert.doesNotThrow(() => 确保配置结构({ 反代: '坏值' }, 默认));
	// 原对象被就地修复（调用方随后继续读取）
	const 目标 = {};
	确保配置结构(目标, 默认);
	assert.equal(目标.PATH, '/');
});

test('CF 用量缓存：同键命中、失败回退默认值', async () => {
	const { 获取CF用量缓存 } = await 加载Worker模块();
	let 调用次数 = 0;
	const 取数 = async () => { 调用次数++; return { success: true, total: 调用次数 }; };
	const 第一次 = await 获取CF用量缓存('k1', 取数);
	const 第二次 = await 获取CF用量缓存('k1', 取数);
	assert.equal(第一次.total, 1);
	assert.equal(第二次.total, 1, '在途/已完成的缓存应被复用');
	await 获取CF用量缓存('k2', async () => { throw new Error('上游挂了') });
	const 失败后 = await 获取CF用量缓存('k2', 取数);
	assert.deepEqual(失败后, { success: false, pages: 0, workers: 0, total: 0, max: 100000 }, '失败必须回退默认值而不是抛出');
});

test('登录限流：10 次窗口后拒绝、成功后清零', async () => {
	const { 记录登录尝试, 清除登录失败记录 } = await 加载Worker模块();
	const IP = '9.9.9.9';
	清除登录失败记录(IP);
	for (let i = 0; i < 10; i++) assert.equal(记录登录尝试(IP), true, `第 ${i + 1} 次应放行`);
	assert.equal(记录登录尝试(IP), false, '超过 10 次必须拒绝');
	清除登录失败记录(IP);
	assert.equal(记录登录尝试(IP), true, '清除后重新放行');
});

test('带超时 fetch：正常返回 / 超时中止', async () => {
	const { 带超时fetch } = await 加载Worker模块();
	const 原fetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const 信号 = init?.signal;
		if (String(url).includes('slow')) {
			return new Promise((resolve, reject) => {
				信号?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			});
		}
		return new Response('ok');
	};
	try {
		assert.equal(await (await 带超时fetch('https://example.com/fast', {}, 1000)).text(), 'ok');
		const 开始 = Date.now();
		await assert.rejects(() => 带超时fetch('https://example.com/slow', {}, 120));
		assert.ok(Date.now() - 开始 < 5000, '超时应在毫秒级生效');
	} finally {
		globalThis.fetch = 原fetch;
	}
});
