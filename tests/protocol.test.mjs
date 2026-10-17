// 协议解析器边界用例：截断、非法地址类型、密码不匹配、首包大小上限
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { 加载Worker模块, 假Reader, 卡死Reader, 构造UUID字节 } from './helpers.mjs';

const UUID = 'd3adb33f-4e57-4e57-8e57-d3adb33fd3ad';

test('Trojan 首包解析：正常/截断/密码错误', async () => {
	const { 解析木马请求, sha224 } = await 加载Worker模块();
	const toBytes = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
	const sha224UUID = toBytes(await sha224(UUID));
	assert.equal(sha224UUID.length, 56);

	const 构造 = (尾部) => {
		const 头 = new Uint8Array(58);
		头.set(sha224UUID, 0);
		头[56] = 0x0d; 头[57] = 0x0a;
		const out = new Uint8Array(58 + 尾部.length);
		out.set(头, 0); out.set(尾部, 58);
		return out;
	};
	// TCP：CMD=1 ATYP=1 IPv4 + port + CRLF + 数据
	const 正常 = 构造(new Uint8Array([1, 1, 1, 2, 3, 4, 0x01, 0xbb, 0x0d, 0x0a, 65, 66]));
	const 结果 = 解析木马请求(正常, UUID);
	assert.equal(结果.hasError, false);
	assert.equal(结果.hostname, '1.2.3.4');
	assert.equal(结果.port, 443);
	assert.equal(结果.isUDP, false);
	assert.equal(结果.rawClientData[0], 65);

	assert.equal(解析木马请求(new Uint8Array(10), UUID).hasError, true);
	const 密码错 = 正常.slice(); 密码错[0] ^= 0xff;
	assert.equal(解析木马请求(密码错, UUID).hasError, true);
	const 截断 = 正常.slice(0, 60);
	assert.equal(解析木马请求(截断, UUID).hasError, true);
});

test('VLESS 首包解析：正常/UUID 不匹配/地址类型非法', async () => {
	const { 解析魏烈思请求 } = await 加载Worker模块();
	const uuidBytes = 构造UUID字节(UUID);
	const buf = new Uint8Array(22 + 4);
	buf[0] = 0;
	buf.set(uuidBytes, 1);
	buf[17] = 0; buf[18] = 1; // optLen=0, cmd=TCP
	buf[19] = 0x01; buf[20] = 0xbb; // port 443
	buf[21] = 1; // atyp IPv4
	buf.set([93, 184, 216, 34], 22);
	const 结果 = 解析魏烈思请求(buf, UUID);
	assert.equal(结果.hasError, false);
	assert.equal(结果.hostname, '93.184.216.34');
	assert.equal(结果.port, 443);

	const 错UUID = buf.slice(); 错UUID[5] ^= 0xff;
	assert.equal(解析魏烈思请求(错UUID, UUID).hasError, true);
	const 坏类型 = buf.slice(); 坏类型[21] = 9;
	assert.equal(解析魏烈思请求(坏类型, UUID).hasError, true);
	assert.equal(解析魏烈思请求(new Uint8Array(3), UUID).hasError, true);
});

test('VLESS 域名地址', async () => {
	const { 解析魏烈思请求 } = await 加载Worker模块();
	const uuidBytes = 构造UUID字节(UUID);
	const 域名 = 'example.com';
	const buf = new Uint8Array(22 + 1 + 域名.length + 4);
	buf.set(uuidBytes, 1);
	buf[17] = 0; buf[18] = 1; buf[19] = 0x01; buf[20] = 0xbb;
	buf[21] = 2; buf[22] = 域名.length;
	for (let i = 0; i < 域名.length; i++) buf[23 + i] = 域名.charCodeAt(i);
	const 结果 = 解析魏烈思请求(buf, UUID);
	assert.equal(结果.hasError, false);
	assert.equal(结果.hostname, 域名);
});

test('XHTTP 首包读取：正常/垃圾/空流/超限', async () => {
	const { 读取叉HTTP首包 } = await 加载Worker模块();
	const uuidBytes = 构造UUID字节(UUID);
	const 首包 = new Uint8Array(26);
	首包.set(uuidBytes, 1);
	首包[17] = 0; 首包[18] = 1; 首包[19] = 0x01; 首包[20] = 0xbb; 首包[21] = 1;
	首包.set([93, 184, 216, 34], 22);
	const 结果 = await 读取叉HTTP首包(假Reader([首包]), UUID);
	assert.equal(结果.协议, 'vl' + 'ess');
	assert.equal(结果.hostname, '93.184.216.34');

	assert.equal(await 读取叉HTTP首包(假Reader([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20])]), UUID), null);
	assert.equal(await 读取叉HTTP首包(假Reader([]), UUID), null);
	// 超过 64KB 上限：必须返回 null 而不是无限增长缓冲
	const 大块 = new Uint8Array(70 * 1024, 0x41);
	assert.equal(await 读取叉HTTP首包(假Reader([大块]), UUID), null);
});

test('XHTTP 首包读取：半开连接不再无限挂住（超时）', async () => {
	const { 读取叉HTTP首包 } = await 加载Worker模块();
	const 开始 = Date.now();
	await assert.rejects(() => 读取叉HTTP首包(卡死Reader(), UUID), /超时/, '应当超时拒绝');
	assert.ok(Date.now() - 开始 < 20000, '超时应远短于 Worker 平台上限');
});

test('gRPC 首帧读取：正常/超大帧/超大声明/半开', async () => {
	const { 读取首个gRPC帧载荷 } = await 加载Worker模块();
	const 载荷 = new Uint8Array([1, 2, 3, 4]);
	const 帧 = new Uint8Array(5 + 载荷.length);
	帧[4] = 载荷.length;
	帧.set(载荷, 5);
	const 结果 = await 读取首个gRPC帧载荷(假Reader([帧]));
	assert.deepEqual(Array.from(结果.payload), [1, 2, 3, 4]);

	// 帧长度声明超过 2MB
	const 坏帧 = new Uint8Array(5);
	坏帧[1] = 0x7f; 坏帧[2] = 0xff; 坏帧[3] = 0xff; 坏帧[4] = 0xff;
	await assert.rejects(() => 读取首个gRPC帧载荷(假Reader([坏帧])), /too large/);

	// 持续发送不足一帧的数据：必须因总量上限抛错，而不是无限缓冲
	// 声明帧长恰为 2MB（合法但要求 2MB+5 字节才成一帧），总量越过 2MB 上限时抛错
	const 不完帧头 = new Uint8Array(5);
	不完帧头[1] = 0x00; 不完帧头[2] = 0x20; 不完帧头[3] = 0x00; 不完帧头[4] = 0x00;
	const 小块 = new Uint8Array(1024);
	小块.set(不完帧头, 0);
	const 开始 = Date.now();
	await assert.rejects(() => 读取首个gRPC帧载荷(假Reader(Array(3000).fill(小块))), /too large/, '应在到达上限时抛错');
	assert.ok(Date.now() - 开始 < 20000);

	const 开始2 = Date.now();
	await assert.rejects(() => 读取首个gRPC帧载荷(卡死Reader()), /超时/);
	assert.ok(Date.now() - 开始2 < 20000);
});

test('gRPC 长度前缀剥离', async () => {
	const { 剥离gRPC长度前缀 } = await 加载Worker模块();
	assert.deepEqual(Array.from(剥离gRPC长度前缀(new Uint8Array([0x0a, 3, 9, 9, 9]))), [9, 9, 9]);
	assert.deepEqual(Array.from(剥离gRPC长度前缀(new Uint8Array([9, 9]))), [9, 9]);
	assert.deepEqual(Array.from(剥离gRPC长度前缀(new Uint8Array([0x0a]))), [0x0a]);
	// 过长的 varint（shift>35）必须原样返回而不是死循环
	assert.deepEqual(Array.from(剥离gRPC长度前缀(new Uint8Array([0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 1]))), [0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f, 1]);
});
