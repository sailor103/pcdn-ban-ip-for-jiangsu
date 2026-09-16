# 日志分析工具

一条命令完成：从 logs 筛选高频/高流量 IP，按连续出现次数聚合 `/24`、`/16`，再与 `all_ip.origin.txt` 合并去重。

## 使用方法

```bash
npm install
npm start
```

## 处理规则

1. 读取 `logs/` 下全部 `.gz` 日志，按文件名中的日期分组，**按天**统计每个 IP 的访问次数与响应流量（不把多天加总）
2. 某一天 **访问次数 > 500** 或 **流量 > 50 MiB** 即保留该 IP（多天命中会各记一行）
3. 剔除境外 IP（非中国大陆，含港澳台；归属地未知也剔除），以及搜索引擎爬虫 IP（请求中爬虫 UA 占一半及以上，如 Google、Bing、百度、搜狗、360、神马、头条、Applebot）
4. 排序后同一网段连续出现 **5 次以上** 才聚合：
   - 同一 `/24` 内 ≥ 5 个 IP → `x.x.x.0/24`
   - 同一 `/16` 内 ≥ 5 个 `/24` → `x.x.0.0/16`
   - 其余保留为单个 IP
5. 与 `all_ip.origin.txt` 合并（origin 里能判定为境外的条目也会去掉），去掉被更大网段覆盖的小段，写出 `all_ip.txt`

## 输出

- `ip-statistics.csv`：按天符合阈值的 IP（日期、地址、当天访问次数、当天流量字节、归属地）
- `all_ip.txt`：与 origin 合并后的封禁列表

## 注意事项

- IP 归属地使用本地 `ip2region_v4.xdb`，无需网络
- 请确保项目根目录有 `ip2region_v4.xdb`（可从 [ip2region](https://github.com/lionsoul2014/ip2region) 下载）
- `all_ip.origin.txt` 作为基准列表，脚本不会改写该文件
