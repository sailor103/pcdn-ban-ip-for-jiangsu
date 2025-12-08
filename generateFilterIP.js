import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// IP 地址转换为 BigInt 用于排序（避免 32 位整数溢出）
function ipToBigInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return BigInt(0);
  return BigInt(parts[0]) * BigInt(256*256*256) + 
         BigInt(parts[1]) * BigInt(256*256) + 
         BigInt(parts[2]) * BigInt(256) + 
         BigInt(parts[3]);
}

// 解析 IP 段，返回 { ip, cidr, network, mask }
function parseIPSegment(ipSegment) {
  const parts = ipSegment.split('/');
  const ip = parts[0];
  const cidr = parts.length > 1 ? parseInt(parts[1]) : 32;
  const ipNum = ipToBigInt(ip);
  const hostBits = BigInt(32 - cidr);
  // 计算网络地址：将主机位清零
  // 创建一个掩码，前 cidr 位为 1，后 hostBits 位为 0
  const mask = (BigInt(0xFFFFFFFF) << hostBits) & BigInt(0xFFFFFFFF);
  const network = ipNum & mask;
  return { ip, cidr, network, hostBits, original: ipSegment };
}

// 检查一个 IP 段是否被另一个段包含
function isContained(smallSegment, largeSegment) {
  // 直接使用字符串解析，避免 parseIPSegment 的问题
  const smallParts = smallSegment.split('/')[0].split('.').map(Number);
  const largeParts = largeSegment.split('/')[0].split('.').map(Number);
  const smallCidr = parseInt(smallSegment.split('/')[1] || '32');
  const largeCidr = parseInt(largeSegment.split('/')[1] || '32');
  
  // 如果小段的 CIDR 小于等于大段的 CIDR，说明小段不够具体或相同，不可能被包含
  // 只有小段的 CIDR 大于大段的 CIDR 时，小段才可能被大段包含
  if (smallCidr <= largeCidr) {
    return false;
  }
  
  // 计算需要比较的字节数（CIDR / 8）
  const bytesToCompare = Math.floor(largeCidr / 8);
  const bitsInLastByte = largeCidr % 8;
  
  // 比较完整的字节
  for (let i = 0; i < bytesToCompare; i++) {
    if (smallParts[i] !== largeParts[i]) {
      return false;
    }
  }
  
  // 如果有部分字节需要比较（bitsInLastByte > 0）
  if (bitsInLastByte > 0 && bytesToCompare < 4) {
    const smallByte = smallParts[bytesToCompare];
    const largeByte = largeParts[bytesToCompare];
    const mask = 0xFF << (8 - bitsInLastByte);
    if ((smallByte & mask) !== (largeByte & mask)) {
      return false;
    }
  }
  
  return true;
}

// 合并 IP 段：移除被更大段包含的小段
function mergeIPSegments(ipSegments) {
  const result = [];
  const toRemove = new Set();
  
  // 先按 CIDR 从小到大排序（先处理大段，再处理小段）
  const sorted = [...ipSegments].sort((a, b) => {
    const aCidr = a.includes('/') ? parseInt(a.split('/')[1]) : 32;
    const bCidr = b.includes('/') ? parseInt(b.split('/')[1]) : 32;
    if (aCidr !== bCidr) {
      return aCidr - bCidr; // CIDR 从小到大排序（/16 在 /24 前面）
    }
    // CIDR 相同的情况下，按 IP 地址排序
    const ipA = a.split('/')[0];
    const ipB = b.split('/')[0];
    const numA = ipToBigInt(ipA);
    const numB = ipToBigInt(ipB);
    if (numA < numB) return -1;
    if (numA > numB) return 1;
    return 0;
  });
  
  // 检查每个段是否被其他更大的段包含
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const currentCidr = current.includes('/') ? parseInt(current.split('/')[1]) : 32;
    let isContainedByOther = false;
    
    // 检查是否被任何更大的段（CIDR 更小）包含
    for (let j = 0; j < i; j++) {
      const larger = sorted[j];
      const largerCidr = larger.includes('/') ? parseInt(larger.split('/')[1]) : 32;
      
      // 只检查 CIDR 更小的段（更大的网络）
      if (largerCidr < currentCidr) {
        if (isContained(current, larger)) {
          isContainedByOther = true;
          break;
        }
      }
    }
    
    if (!isContainedByOther) {
      result.push(current);
    } else {
      toRemove.add(current);
    }
  }
  
  return { merged: result, removed: Array.from(toRemove) };
}

// 比较函数：先按 IP 地址排序，再按 CIDR 前缀长度排序
function compareIPs(a, b) {
  // 提取 IP 地址部分（去掉 /xx）
  const ipA = a.split('/')[0];
  const ipB = b.split('/')[0];
  
  // 先按 IP 地址数字排序（使用 BigInt 避免溢出）
  const numA = ipToBigInt(ipA);
  const numB = ipToBigInt(ipB);
  
  if (numA < numB) return -1;
  if (numA > numB) return 1;
  
  // IP 相同的情况下，按 CIDR 前缀长度排序（如果有的话）
  const cidrA = a.includes('/') ? parseInt(a.split('/')[1]) : 32;
  const cidrB = b.includes('/') ? parseInt(b.split('/')[1]) : 32;
  return cidrA - cidrB;
}

// 主函数
function main() {
  const inputFile = path.join(__dirname, 'all_ip.origin.txt');
  const outputFile = path.join(__dirname, 'all_ip.txt');
  
  console.log('开始处理 IP 列表...');
  
  // 检查输入文件是否存在
  if (!fs.existsSync(inputFile)) {
    console.error(`错误：文件 ${inputFile} 不存在`);
    process.exit(1);
  }
  
  // 读取文件内容
  const content = fs.readFileSync(inputFile, 'utf-8');
  const lines = content.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0); // 过滤空行
  
  console.log(`读取到 ${lines.length} 行数据`);
  
  // 去重（使用 Set）
  const uniqueIPs = new Set(lines);
  console.log(`去重后剩余 ${uniqueIPs.size} 个 IP`);
  
  // 合并 IP 段：移除被更大段包含的小段
  console.log('开始合并 IP 段...');
  const { merged, removed } = mergeIPSegments(Array.from(uniqueIPs));
  console.log(`合并后剩余 ${merged.length} 个 IP 段`);
  if (removed.length > 0) {
    console.log(`移除了 ${removed.length} 个被包含的小段：`);
    removed.slice(0, 20).forEach(ip => console.log(`  - ${ip}`));
    if (removed.length > 20) {
      console.log(`  ... 还有 ${removed.length - 20} 个`);
    }
  } else {
    console.log('没有需要合并的 IP 段');
  }
  
  // 转换为数组并排序
  const sortedIPs = merged.sort(compareIPs);
  
  // 写入输出文件
  const outputContent = sortedIPs.join('\n') + '\n';
  fs.writeFileSync(outputFile, outputContent, 'utf-8');
  
  console.log(`\n处理完成！`);
  console.log(`- 原始行数：${lines.length}`);
  console.log(`- 去重后：${uniqueIPs.size} 个`);
  console.log(`- 合并后：${merged.length} 个`);
  console.log(`- 已保存到：${outputFile}`);
  
  // 显示前 10 条作为示例
  console.log(`\n前 10 条记录：`);
  sortedIPs.slice(0, 10).forEach((ip, index) => {
    console.log(`  ${index + 1}. ${ip}`);
  });
}

// 导出函数供测试使用
export { parseIPSegment, isContained, ipToBigInt };

// 运行主函数
main();

