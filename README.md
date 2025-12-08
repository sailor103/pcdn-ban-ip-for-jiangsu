# 日志分析工具

这个工具用于：
- 分析 logs 目录下的日志文件，统计 IP 访问次数并查询 IP 归属地，生成 `ip-statistics.csv`
- 筛选江苏地区高频 IP，生成 `/24` 与 `/16` 聚合前缀
- 对外部 IP 列表去重、排序并自动合并被大段覆盖的小段，生成整合后的 IP 列表

## 功能特性

- 自动读取 logs 目录下所有 .gz 压缩日志文件
- 统计每个 IP 地址的访问次数
- 查询 IP 归属地信息（国家、地区、城市、ISP）
- 按访问次数降序排序
- 生成 CSV 格式的统计报告

## 使用方法

1. 安装依赖：
```bash
npm install
```

2. 运行日志分析程序：
```bash
npm start
# 或
node analyze-logs.js
```

3. 筛选江苏高频 IP（可选）：
```bash
node filterJiangSu.js
```
输出：
- `jiangsu_filtered.csv`：江苏地区且访问次数 > 80 的 IP 列表
- `jiangsu_cidrs.txt`：基于前三段 `/24`、前两段 `/16` 的聚合前缀

4. 处理自定义 IP 列表（可选）：
将原始列表放入 `all_ip.origin.txt`，然后运行：
```bash
node generateFilterIP.js
```
输出：
- `all_ip.txt`：去重、排序并合并（被大段包含的小段会移除）

5. 查看结果：
程序会在当前目录生成 `ip-statistics.csv` 文件，包含以下列：
- IP地址
- 访问次数
- 归属地

## 注意事项

- IP 归属地查询使用本地 `ip2region_v4.xdb` 数据库文件，无需网络连接
- 使用官方 [ip2region.js](https://github.com/lionsoul2014/ip2region/tree/master/binding/javascript) 包进行查询
- 查询速度快速，无速率限制
- IP 归属地查询结果会被缓存，避免重复查询相同 IP
- 如果查询失败，归属地会显示为"未知"
- 确保项目根目录下有 `ip2region_v4.xdb` 文件（可从 [ip2region 官方仓库](https://github.com/lionsoul2014/ip2region) 下载）

## 输出示例（日志分析）

CSV 文件格式：
```csv
IP地址,访问次数,归属地
175.8.24.102,1523,中国 湖南省 长沙市 中国电信
14.154.16.233,856,中国 广东省 深圳市 中国电信
...
```

