import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CSV_PATH = path.resolve(__dirname, 'ip-statistics.csv');
const OUTPUT_FILTERED = path.resolve(__dirname, 'jiangsu_filtered.csv');
const OUTPUT_CIDR = path.resolve(__dirname, 'jiangsu_cidrs.txt');

// 简单的 CSV 解析（假设字段内无逗号）
function parseCsv(content) {
  const lines = content.trim().split('\n');
  const header = lines.shift();
  const records = [];
  for (const line of lines) {
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const [ip, countStr, location] = parts;
    const count = Number(countStr);
    records.push({ ip: ip.trim(), count, location: location?.trim() || '' });
  }
  return { header, records };
}

// 生成 CIDR 前缀
function buildCidrs(ips) {
  const prefixes24 = new Set(); // 前三段 -> /24
  const prefixes16 = new Set(); // 前两段 -> /16

  for (const ip of ips) {
    const segments = ip.split('.');
    if (segments.length !== 4) continue;
    const [a, b, c] = segments;
    prefixes24.add(`${a}.${b}.${c}.0/24`);
    prefixes16.add(`${a}.${b}.0.0/16`);
  }

  return {
    cidr24: Array.from(prefixes24).sort(),
    cidr16: Array.from(prefixes16).sort(),
  };
}

function main() {
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`未找到 CSV 文件: ${CSV_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(CSV_PATH, 'utf8');
  const { records } = parseCsv(content);

  // 筛选：归属地包含“江苏”，且访问次数 > 80
  const filtered = records.filter(
    (r) => r.count > 80 && r.location.includes('江苏')
  );

  // 生成 CIDR
  const { cidr24, cidr16 } = buildCidrs(filtered.map((r) => r.ip));

  // 写出筛选后的 CSV
  const filteredCsvLines = ['IP地址,访问次数,归属地'].concat(
    filtered.map((r) => `${r.ip},${r.count},${r.location}`)
  );
  fs.writeFileSync(OUTPUT_FILTERED, filteredCsvLines.join('\n'), 'utf8');

  // 写出 CIDR 列表
  const cidrLines = [
    '# /24 前缀（前三段相同）',
    ...cidr24,
    '',
    '# /16 前缀（前两段相同）',
    ...cidr16,
  ];
  fs.writeFileSync(OUTPUT_CIDR, cidrLines.join('\n'), 'utf8');

  console.log(`筛选完成，结果：`);
  console.log(`- 符合条件的 IP 数量：${filtered.length}`);
  console.log(`- 已输出筛选结果：${OUTPUT_FILTERED}`);
  console.log(`- 已输出 CIDR 列表：${OUTPUT_CIDR}`);
}

main();

