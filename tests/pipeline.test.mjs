// 收发管道单测：Grain 收纳器、上行写入队列（溢出/重试/完成回调）、下行发送器
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { 加载Worker模块 } from './helpers.mjs';

test('Grain 收纳器：字节记账、按容量合包、清空', async () => {
	const { 创建Grain收纳器 } = await 加载Worker模块();
	const 收纳 = 创建Grain收纳器(1024);
	assert.equal(收纳.收纳({ chunk: new Uint8Array(100) }), true);
	assert.equal(收纳.收纳({ chunk: new Uint8Array(50) }), true);
	assert.equal(收纳.字节数, 150);
	assert.equal(收纳.收纳({ chunk: new Uint8Array(0) }), false, '空块不入队');

	const 合包 = 收纳.合包();
	assert.equal(合包.chunk.byteLength, 150);
	assert.equal(合包.items.length, 2);
	assert.equal(收纳.字节数, 0);
	assert.equal(收纳.为空, true);

	// 超过容量的块单独成包
	收纳.收纳({ chunk: new Uint8Array(2000) });
	const 大包 = 收纳.合包();
	assert.equal(大包.chunk.byteLength, 2000);
	assert.equal(大包.items.length, 1);

	收纳.收纳({ chunk: new Uint8Array(10) });
	收纳.收纳({ chunk: new Uint8Array(10) });
	收纳.清空();
	assert.equal(收纳.字节数, 0);
	assert.equal(收纳.条目数, 0);
});

test('上行写入队列：写入、完成回调、溢出关闭', async () => {
	const { 创建上行写入队列 } = await 加载Worker模块();
	const 已写入 = [];
	let socket = { writable: { getWriter: () => ({ write: async (c) => { 已写入.push(c.byteLength) }, releaseLock() { } }) } };
	const 队列 = 创建上行写入队列({
		获取写入器: () => socket ? socket.writable.getWriter() : null,
		获取连接任务: () => null,
		释放写入器: () => { },
		重试连接: async () => { },
		关闭连接: () => { },
		名称: '测试队列',
	});
	assert.equal(await 队列.写入(new Uint8Array(100)), true);
	await 队列.写入并等待(new Uint8Array(50));
	assert.equal(已写入.reduce((a, b) => a + b, 0), 150, '字节数守恒');
	assert.ok(已写入.length >= 1);

	// 溢出：nextBytes 超过 16MB 必须抛错并标记关闭
	const 巨块 = new Uint8Array(17 * 1024 * 1024);
	await assert.rejects(async () => 队列.写入(巨块), /overflow|溢出/);
	assert.equal(队列.写入(new Uint8Array(10)), false, '关闭后不再接收');
});

test('上行写入队列：首包阶段无 writer 时返回 false 交给上层解析', async () => {
	const { 创建上行写入队列 } = await 加载Worker模块();
	const 队列 = 创建上行写入队列({
		获取写入器: () => null,
		获取连接任务: () => null,
		释放写入器: () => { },
		重试连接: async () => { },
		关闭连接: () => { },
		名称: '测试队列2',
	});
	assert.equal(await 队列.写入(new Uint8Array(10)), false);
});

test('上行写入队列：写入失败触发重试并最终成功', async () => {
	const { 创建上行写入队列 } = await 加载Worker模块();
	let 尝试次数 = 0;
	const 已写入 = [];
	let 已连接 = true;
	let 应失败一次 = true;
	const 队列 = 创建上行写入队列({
		获取写入器: () => 已连接 ? {
			write: async (c) => {
				if (应失败一次) { 应失败一次 = false; throw new Error('连接抖动') }
				已写入.push(c.byteLength);
			},
			releaseLock() { },
		} : null,
		获取连接任务: () => null,
		释放写入器: () => { 已连接 = false },
		重试连接: async () => { 尝试次数++; 已连接 = true },
		关闭连接: () => { },
		名称: '测试队列3',
	});
	await 队列.写入并等待(new Uint8Array(64));
	assert.equal(尝试次数, 1, '写入失败应重试连接一次');
	assert.deepEqual(已写入, [64], '重试后数据必须补写成功');
});

test('下行 Grain 发送器：批量合包与停止刷新', async () => {
	const { 创建下行Grain发送器 } = await 加载Worker模块();
	const 已发送 = [];
	const 假WS = { readyState: 1, send: async (data) => { 已发送.push(data.byteLength || data.length || 0) } };
	const 发送器 = 创建下行Grain发送器(假WS, null, null);
	await 发送器.发送(new Uint8Array(1000));
	await 发送器.发送(new Uint8Array(1000));
	await 发送器.停止并刷新();
	assert.ok(已发送.length >= 1, '应有数据经 WS 发出');
	assert.equal(已发送.reduce((a, b) => a + b, 0), 2000, '字节数必须守恒');
});

test('下行发送器：连接失效后丢弃而不报错', async () => {
	const { 创建下行Grain发送器 } = await 加载Worker模块();
	const 假WS = { readyState: 3, send: async () => { throw new Error('不应发送') } };
	const 发送器 = 创建下行Grain发送器(假WS, null, () => false);
	await 发送器.发送(new Uint8Array(100));
	await 发送器.停止并刷新();
});

test('工具函数：地址判定、数组整理、常量时间比较', async () => {
	const W = await 加载Worker模块();
	assert.equal(W.isIPv4('1.2.3.4'), true);
	assert.equal(W.isIPv4('256.1.1.1'), false);
	assert.equal(W.isIPHostname('[2001:db8::1]'), true);
	assert.equal(W.isIPHostname('example.com'), false);
	assert.equal(W.stripIPv6Brackets('[::1]'), '::1');
	assert.deepEqual(await W.整理成数组('a.com\nb.com, c.com'), ['a.com', 'b.com', ' c.com']);
	assert.equal(W.掩码敏感信息('abcdefghij'), 'abc*****ij');
	assert.equal(W.掩码敏感信息('短'), '短');
	assert.equal(W.isSpeedTestSite('speed.cloudflare.com'), true);
	assert.equal(W.isSpeedTestSite('evil-speed.cloudflare.com.evil.com'), false);
	assert.equal(W.常量时间比较('abc', 'abc'), true);
	assert.equal(W.常量时间比较('abc', 'abd'), false);
	assert.equal(W.常量时间比较('abc', 'abcd'), false);
	assert.equal(W.常量时间比较(null, 'a'), false);
});

test('本地 204 响应构造', async () => {
	const W = await 加载Worker模块();
	const 响应 = W.构造本地204响应();
	const 文本 = new TextDecoder().decode(响应);
	assert.match(文本, /204 No Content/);
	const 带头 = W.构造本地204响应(new Uint8Array([1, 0]));
	assert.equal(带头[0], 1);
	assert.equal(带头[1], 0);
	assert.match(new TextDecoder().decode(带头), /204 No Content/);
});
