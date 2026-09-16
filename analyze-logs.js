import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { createObjectCsvWriter } from 'csv-writer';
import { newWithFileOnly, IPv4 } from 'ip2region.js';
import { mergeIPSegments, compareIPs, ipToBigInt } from './generateFilterIP.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIN_COUNT = 500;
const MIN_BYTES = 50 * 1024 * 1024; // 50 MiB，按单日统计
const MIN_CONSECUTIVE = 5;

// 搜索引擎爬虫 UA。不含 SEO 抓取器、通用 crawler。
const SEARCH_CRAWLER_UA = /(?:googlebot|google-inspectiontool|adsbot-google|mediapartners-google|storebot-google|bingbot|msnbot|bingpreview|baiduspider|sogou|360spider|yisouspider|haosouspider|bytespider|applebot|duckduckbot|yandex(?:bot|images)|petalbot|oai-searchbot|amzn-searchbot|amazonbot|meta-webindexer|exasearchbot)/i;

const OVERSEAS_REGION = /香港|澳门|澳門|台湾|臺灣/;

const ipLocationCache = new Map();

const dbPath = path.resolve(__dirname, 'ip2region_v4.xdb');
let ip2regionSearcher = null;

function initIp2Region() {
  if (!ip2regionSearcher) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`IP 数据库文件不存在: ${dbPath}`);
    }
    ip2regionSearcher = newWithFileOnly(IPv4, dbPath);
  }
  return ip2regionSearcher;
}

async function getIpLocation(ip) {
  if (ipLocationCache.has(ip)) {
    return ipLocationCache.get(ip);
  }

  try {
    const searcher = initIp2Region();
    const region = await searcher.search(ip);

    if (region && region.trim()) {
      const parts = region.split('|');
      const locationParts = [];

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]?.trim();
        if (part && part !== '0' && part !== '内网IP') {
          locationParts.push(part);
        }
      }

      const location = locationParts.join(' ') || '未知';
      ipLocationCache.set(ip, location);
      return location;
    }

    ipLocationCache.set(ip, '未知');
    return '未知';
  } catch (error) {
    console.error(`查询 IP ${ip} 失败:`, error.message);
    ipLocationCache.set(ip, '未知');
    return '未知';
  }
}

async function batchQueryIpLocations(ips) {
  const results = new Map();

  for (let i = 0; i < ips.length; i++) {
    const ip = ips[i];
    results.set(ip, await getIpLocation(ip));

    if ((i + 1) % 100 === 0 || i === ips.length - 1) {
      console.log(`已查询 ${i + 1}/${ips.length} 个 IP 地址...`);
    }
  }

  return results;
}

function parseBytes(value) {
  if (!value || value === '-') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function parseLogLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = trimmed.match(
    /^(\d+\.\d+\.\d+\.\d+)\s+\S+\s+\S+\s+\[[^\]]*\]\s+"[^"]*"\s+\d+\s+(\d+|-)\s+"[^"]*"\s+"([\s\S]*)"\s*$/
  );
  if (match) {
    return {
      ip: match[1],
      bytes: parseBytes(match[2]),
      crawler: SEARCH_CRAWLER_UA.test(match[3])
    };
  }

  const fallback = trimmed.match(
    /^(\d+\.\d+\.\d+\.\d+)\s+\S+\s+\S+\s+\[[^\]]*\]\s+"[^"]*"\s+\d+\s+(\d+|-)/
  );
  if (fallback) {
    return { ip: fallback[1], bytes: parseBytes(fallback[2]), crawler: false };
  }

  const ipOnly = trimmed.match(/^(\d+\.\d+\.\d+\.\d+)/);
  if (ipOnly) {
    return { ip: ipOnly[1], bytes: 0, crawler: false };
  }

  return null;
}

export function isSearchCrawlerUa(ua) {
  return SEARCH_CRAWLER_UA.test(ua || '');
}

export function isMainlandChina(location) {
  if (!location || location === '未知') return false;
  if (!location.startsWith('中国')) return false;
  return !OVERSEAS_REGION.test(location);
}

function isCrawlerIp(stat) {
  return stat.crawler > 0 && stat.crawler * 2 >= stat.count;
}

function addStat(stats, ip, bytes, crawler) {
  const prev = stats.get(ip) || { count: 0, bytes: 0, crawler: 0 };
  prev.count += 1;
  prev.bytes += bytes;
  if (crawler) prev.crawler += 1;
  stats.set(ip, prev);
}

export function logDateFromFilename(filename) {
  const match = path.basename(filename).match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function groupLogFilesByDate(files) {
  const groups = new Map();
  for (const file of files) {
    const date = logDateFromFilename(file) || 'unknown';
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(file);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function processLogFile(filePath, stats) {
  return new Promise((resolve, reject) => {
    const fileStream = fs.createReadStream(filePath);
    const gunzip = zlib.createGunzip();

    let buffer = '';

    fileStream.pipe(gunzip)
      .on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const parsed = parseLogLine(line);
          if (parsed) addStat(stats, parsed.ip, parsed.bytes, parsed.crawler);
        }
      })
      .on('end', () => {
        if (buffer) {
          const parsed = parseLogLine(buffer);
          if (parsed) addStat(stats, parsed.ip, parsed.bytes, parsed.crawler);
        }
        resolve();
      })
      .on('error', reject);
  });
}

function prefix24(ip) {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

function prefix16(ip) {
  const parts = ip.split('.');
  return `${parts[0]}.${parts[1]}`;
}

function itemIp(item) {
  return item.split('/')[0];
}

export function aggregateCidrs(ips, minConsecutive = MIN_CONSECUTIVE) {
  const unique = [...new Set(ips.filter((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)))];
  unique.sort((a, b) => {
    const na = ipToBigInt(a);
    const nb = ipToBigInt(b);
    if (na < nb) return -1;
    if (na > nb) return 1;
    return 0;
  });

  const by24 = new Map();
  for (const ip of unique) {
    const key = prefix24(ip);
    if (!by24.has(key)) by24.set(key, []);
    by24.get(key).push(ip);
  }

  const after24 = [];
  for (const [key, group] of by24) {
    if (group.length >= minConsecutive) {
      after24.push(`${key}.0/24`);
    } else {
      after24.push(...group);
    }
  }

  after24.sort(compareIPs);

  const by16 = new Map();
  for (const item of after24) {
    const key = prefix16(itemIp(item));
    if (!by16.has(key)) by16.set(key, []);
    by16.get(key).push(item);
  }

  const result = [];
  for (const [key, group] of by16) {
    const cidr24Count = group.filter((item) => item.endsWith('/24')).length;
    if (cidr24Count >= minConsecutive) {
      result.push(`${key}.0.0/16`);
    } else {
      result.push(...group);
    }
  }

  return result.sort(compareIPs);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KiB`;
  }
  return `${bytes} B`;
}

function readOriginIps(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`未找到 ${filePath}，将只使用本次分析结果`);
    return [];
  }

  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

async function main() {
  const logsDir = path.join(__dirname, 'logs');
  const originFile = path.join(__dirname, 'all_ip.origin.txt');
  const outputFile = path.join(__dirname, 'all_ip.txt');

  console.log('开始按天读取日志文件...');
  console.log(`单日阈值：访问 > ${MIN_COUNT} 或流量 > ${formatBytes(MIN_BYTES)}`);

  const files = fs.readdirSync(logsDir)
    .filter((file) => file.endsWith('.gz'))
    .map((file) => path.join(logsDir, file));

  const dayGroups = groupLogFilesByDate(files);
  console.log(`找到 ${files.length} 个日志文件，覆盖 ${dayGroups.length} 天`);

  const dailyHits = [];
  let overThresholdCount = 0;
  let crawlerDropped = 0;

  for (const [date, dayFiles] of dayGroups) {
    const stats = new Map();
    console.log(`\n==== ${date}（${dayFiles.length} 个文件）====`);

    for (let i = 0; i < dayFiles.length; i++) {
      const file = dayFiles[i];
      console.log(`正在处理: ${path.basename(file)} (${i + 1}/${dayFiles.length})`);
      try {
        await processLogFile(file, stats);
      } catch (error) {
        console.error(`处理文件 ${file} 时出错:`, error.message);
      }
    }

    const dayOver = [...stats.entries()]
      .filter(([, stat]) => stat.count > MIN_COUNT || stat.bytes > MIN_BYTES)
      .sort((a, b) => b[1].count - a[1].count);
    const dayCrawler = dayOver.filter(([, stat]) => isCrawlerIp(stat));
    const dayKept = dayOver.filter(([, stat]) => !isCrawlerIp(stat));

    overThresholdCount += dayOver.length;
    crawlerDropped += dayCrawler.length;
    for (const [ip, stat] of dayKept) {
      dailyHits.push({ ip, date, count: stat.count, bytes: stat.bytes });
    }

    console.log(
      `${date} 统计 ${stats.size} 个 IP，超过阈值 ${dayOver.length}，剔除爬虫 ${dayCrawler.length}，保留 ${dayKept.length}`
    );
  }

  console.log('\n开始查询 IP 归属地...');
  initIp2Region();
  const uniqueCandidateIps = [...new Set(dailyHits.map((hit) => hit.ip))];
  const ipLocations = await batchQueryIpLocations(uniqueCandidateIps);

  const overseasIps = new Set(
    uniqueCandidateIps.filter((ip) => !isMainlandChina(ipLocations.get(ip)))
  );
  const qualifying = dailyHits.filter((hit) => !overseasIps.has(hit.ip));
  const uniqueIps = [...new Set(qualifying.map((hit) => hit.ip))];

  console.log(`单日超过阈值（含跨天重复）：${overThresholdCount}`);
  console.log(`剔除搜索引擎爬虫：${crawlerDropped}`);
  console.log(`剔除非中国大陆 IP：${overseasIps.size}`);
  console.log(`保留 ${uniqueIps.length} 个 IP，${qualifying.length} 条单日记录`);

  const csvData = qualifying
    .map((hit) => ({
      date: hit.date,
      ip: hit.ip,
      count: hit.count,
      bytes: hit.bytes,
      location: ipLocations.get(hit.ip) || '未知'
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || b.count - a.count);

  const csvWriter = createObjectCsvWriter({
    path: 'ip-statistics.csv',
    header: [
      { id: 'date', title: '日期' },
      { id: 'ip', title: 'IP地址' },
      { id: 'count', title: '访问次数' },
      { id: 'bytes', title: '流量(字节)' },
      { id: 'location', title: '归属地' }
    ],
    encoding: 'utf8'
  });
  await csvWriter.writeRecords(csvData);
  console.log('已保存 ip-statistics.csv');

  const aggregated = aggregateCidrs(uniqueIps, MIN_CONSECUTIVE);
  const cidr24 = aggregated.filter((item) => item.endsWith('/24')).length;
  const cidr16 = aggregated.filter((item) => item.endsWith('/16')).length;
  const hosts = aggregated.filter((item) => !item.includes('/')).length;
  console.log(
    `\n聚合结果：${aggregated.length} 条（/16: ${cidr16}, /24: ${cidr24}, 单 IP: ${hosts}）`
  );

  const originIps = readOriginIps(originFile);
  const originKept = [];
  const originDropped = [];
  for (const entry of originIps) {
    const ip = entry.split('/')[0];
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
      originKept.push(entry);
      continue;
    }
    const location = await getIpLocation(ip);
    if (!isMainlandChina(location)) {
      originDropped.push({ entry, location });
      continue;
    }
    originKept.push(entry);
  }
  console.log(`读取 ${path.basename(originFile)}：${originIps.length} 条，剔除境外 ${originDropped.length} 条`);

  const combined = [...new Set([...originKept, ...aggregated])];
  const { merged, removed } = mergeIPSegments(combined);
  const sorted = merged.sort(compareIPs);

  fs.writeFileSync(outputFile, sorted.join('\n') + '\n', 'utf-8');

  if (ip2regionSearcher) {
    ip2regionSearcher.close();
  }

  console.log(`\n完成！`);
  console.log(`- 日志筛选 IP：${uniqueIps.length}（单日记录 ${qualifying.length}，爬虫剔除 ${crawlerDropped}，境外剔除 ${overseasIps.size}）`);
  console.log(`- 聚合后：${aggregated.length}`);
  console.log(`- 与 origin 合并后：${sorted.length}（移除被覆盖 ${removed.length} 条）`);
  console.log(`- 已保存：${outputFile}`);

  console.log(`\n单日访问次数 Top 10:`);
  [...csvData].sort((a, b) => b.count - a.count).slice(0, 10).forEach((item, index) => {
    console.log(
      `${index + 1}. ${item.date} ${item.ip} - ${item.count} 次 - ${formatBytes(item.bytes)} - ${item.location}`
    );
  });
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((error) => {
    console.error('程序执行出错:', error);
    process.exit(1);
  });
}
