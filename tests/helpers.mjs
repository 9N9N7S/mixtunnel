// 测试专用加载器：把唯一真源 _worker.js 复制成 .mjs 并追加 export 列表，
// 这样可以在不改动生产文件、不影响构建产物与 check 的前提下单测内部函数。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const 当前目录 = path.dirname(fileURLToPath(import.meta.url));
const 仓库根 = path.resolve(当前目录, '..');
const 临时目录 = path.join(当前目录, '.tmp');

const 导出清单 = [
	'解析木马请求', '解析魏烈思请求', 'UUID字节匹配', '获取UUID字节',
	'MD5MD5', 'sha224', 'base64SecretEncode', 'base64SecretDecode',
	'裁剪日志数组至字节上限', '剥离gRPC长度前缀', '读取首个gRPC帧载荷', '读取叉HTTP首包',
	'确保配置结构', '获取CF用量缓存', '获取CIDR列表缓存', '派生用户ID',
	'记录登录尝试', '清除登录失败记录', '常量时间比较', '带超时fetch', 'withTimeout',
	'isIPHostname', 'isIPv4', 'stripIPv6Brackets', '整理成数组', '替换星号为随机字符',
	'随机路径', '掩码敏感信息', 'isSpeedTestSite', '识别运营商', '获取代理默认端口',
	'创建Grain收纳器', '创建上行写入队列', '创建下行Grain发送器',
	'构造本地204响应', '构造WS本地204响应', '有效数据长度', '数据转Uint8Array', '拼接字节数据',
	'closeSocketQuietly',
];

let 缓存模块 = null;

export async function 加载Worker模块() {
	if (缓存模块) return 缓存模块;
	fs.mkdirSync(临时目录, { recursive: true });
	const 源 = fs.readFileSync(path.join(仓库根, '_worker.js'), 'utf8').replace(/^\uFEFF/, '');
	const 目标 = path.join(临时目录, 'worker-under-test.mjs');
	fs.writeFileSync(目标, 源 + '\n\nexport { ' + 导出清单.join(', ') + ' };\n', 'utf8');
	缓存模块 = await import('file://' + 目标.replace(/\\/g, '/'));
	return 缓存模块;
}

// 构造一个只读一次的假 reader，用于首包/首帧读取测试
export function 假Reader(分块列表, 选项 = {}) {
	let 下标 = 0;
	return {
		read: async () => {
			if (选项.读取前延时) await new Promise(r => setTimeout(r, 选项.读取前延时));
			if (下标 >= 分块列表.length) return { done: true, value: undefined };
			return { done: false, value: 分块列表[下标++] };
		},
		releaseLock() { },
		cancel() { },
	};
}

// 永不返回的假 reader（模拟客户端半开连接）
export function 卡死Reader() {
	return {
		read: () => new Promise(() => { }),
		releaseLock() { },
		cancel() { },
	};
}

export function 构造UUID字节(uuid) {
	const clean = uuid.replace(/-/g, '');
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	return bytes;
}
