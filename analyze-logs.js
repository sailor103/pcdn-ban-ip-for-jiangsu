import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { createObjectCsvWriter } from 'csv-writer';
import { newWithFileOnly, IPv4 } from 'ip2region.js';

// 获取 __dirname 的 ES module 等价物
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// IP 统计 Map
const ipStats = new Map();

// IP 归属地缓存（避免重复查询）
const ipLocationCache = new Map();

// 初始化 ip2region 查询器
const dbPath = path.resolve(__dirname, 'ip2region_v4.xdb');
let ip2regionSearcher = null;

// 初始化 IP2Region 实例
function initIp2Region() {
  if (!ip2regionSearcher) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`IP 数据库文件不存在: ${dbPath}`);
    }
    // 使用 newWithFileOnly 创建查询器
    ip2regionSearcher = newWithFileOnly(IPv4, dbPath);
  }
  return ip2regionSearcher;
}

// 查询 IP 归属地的函数（使用本地 ip2region 数据库）
async function getIpLocation(ip) {
  // 检查缓存
  if (ipLocationCache.has(ip)) {
    return ipLocationCache.get(ip);
  }

  try {
    const searcher = initIp2Region();
    const region = await searcher.search(ip);
    
    if (region && region.trim()) {
      // region 格式：国家|区域|省份|城市|ISP
      // 例如：中国|0|湖南省|长沙市|电信 或 中国|湖南省|长沙市|电信
      const parts = region.split('|');
      const locationParts = [];
      
      // 过滤掉 "0" 和空字符串，保留有效信息
      // 注意：有些格式可能是 国家|省份|城市|ISP（4部分），有些是 国家|区域|省份|城市|ISP（5部分）
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]?.trim();
        if (part && part !== '0' && part !== '内网IP') {
          locationParts.push(part);
        }
      }
      
      const location = locationParts.join(' ') || '未知';
      ipLocationCache.set(ip, location);
      return location;
    } else {
      ipLocationCache.set(ip, '未知');
      return '未知';
    }
  } catch (error) {
    console.error(`查询 IP ${ip} 失败:`, error.message);
    ipLocationCache.set(ip, '未知');
    return '未知';
  }
}

// 批量查询 IP 归属地
async function batchQueryIpLocations(ips) {
  const results = new Map();
  
  for (let i = 0; i < ips.length; i++) {
    const ip = ips[i];
    const location = await getIpLocation(ip);
    results.set(ip, location);
    
    // 显示进度
    if ((i + 1) % 100 === 0 || i === ips.length - 1) {
      console.log(`已查询 ${i + 1}/${ips.length} 个 IP 地址...`);
    }
  }
  
  return results;
}

// 解析日志行，提取 IP 地址
function parseLogLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  
  // 日志格式：IP地址 状态 响应时间 [时间戳] ...
  const match = trimmed.match(/^(\d+\.\d+\.\d+\.\d+)/);
  if (match) {
    return match[1];
  }
  
  return null;
}

// 读取并处理单个日志文件
async function processLogFile(filePath) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath);
    const gunzip = zlib.createGunzip();
    
    let buffer = '';
    
    fileStream.pipe(gunzip)
      .on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留最后一行（可能不完整）
        
        lines.forEach(line => {
          const ip = parseLogLine(line);
          if (ip) {
            ipStats.set(ip, (ipStats.get(ip) || 0) + 1);
          }
        });
      })
      .on('end', () => {
        // 处理最后一行
        if (buffer) {
          const ip = parseLogLine(buffer);
          if (ip) {
            ipStats.set(ip, (ipStats.get(ip) || 0) + 1);
          }
        }
        resolve();
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}

// 主函数
async function main() {
  const logsDir = path.join(__dirname, 'logs');
  
  console.log('开始读取日志文件...');
  
  // 读取 logs 目录下的所有 .gz 文件
  const files = fs.readdirSync(logsDir)
    .filter(file => file.endsWith('.gz'))
    .map(file => path.join(logsDir, file));
  
  console.log(`找到 ${files.length} 个日志文件`);
  
  // 处理所有日志文件
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    console.log(`正在处理: ${path.basename(file)} (${i + 1}/${files.length})`);
    try {
      await processLogFile(file);
    } catch (error) {
      console.error(`处理文件 ${file} 时出错:`, error.message);
    }
  }
  
  console.log(`\n统计完成！共发现 ${ipStats.size} 个不同的 IP 地址`);
  
  // 按访问次数排序
  const sortedIps = Array.from(ipStats.entries())
    .sort((a, b) => b[1] - a[1]);
  
  console.log('\n开始查询 IP 归属地...');
  
  // 初始化 IP2Region
  initIp2Region();
  
  // 批量查询 IP 归属地
  const uniqueIps = sortedIps.map(([ip]) => ip);
  const ipLocations = await batchQueryIpLocations(uniqueIps);
  
  // 准备 CSV 数据
  const csvData = sortedIps.map(([ip, count]) => ({
    ip: ip,
    count: count,
    location: ipLocations.get(ip) || '未知'
  }));
  
  // 生成 CSV 文件
  const csvWriter = createObjectCsvWriter({
    path: 'ip-statistics.csv',
    header: [
      { id: 'ip', title: 'IP地址' },
      { id: 'count', title: '访问次数' },
      { id: 'location', title: '归属地' }
    ],
    encoding: 'utf8'
  });
  
  await csvWriter.writeRecords(csvData);
  
  // 关闭查询器
  if (ip2regionSearcher) {
    ip2regionSearcher.close();
  }
  
  console.log(`\n完成！结果已保存到 ip-statistics.csv`);
  console.log(`\n访问次数 Top 10:`);
  csvData.slice(0, 10).forEach((item, index) => {
    console.log(`${index + 1}. ${item.ip} - ${item.count} 次 - ${item.location}`);
  });
}

// 运行主函数
main().catch(error => {
  console.error('程序执行出错:', error);
  process.exit(1);
});

