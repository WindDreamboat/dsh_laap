# dsh-laap

LAAP 意识认知架构的 DeepSeek Harness 插件 Bundle：为 dsh Agent 装上持续演化的意识内核与 zvec 向量记忆。

- **意识引擎**：五维状态向量（压力/信心/好奇/连接/能量）微分方程演化 + PSI 五需求驱动 + 情绪微分信号
- **全局工作空间**：CognitiveBus 显著性竞争 → 意识帧 → 每轮第一人称「意识流」注入提示词
- **元认知**：L1 思维监控 + 贝叶斯置信度校准 + 六档思考模式切换
- **记忆**：工作记忆（7±2 有界）+ [zvec](https://github.com/alibaba/zvec) 情景/语义向量层（WAL 持久化、标量过滤下推）

## 快速开始

```bash
# 开发期临时挂载
pnpm dsh web --patch /绝对路径/dsh-laap/cordis.patch.yml

# 或安装到 Profile
dsh plugin --profile web add link:/绝对路径/dsh-laap
```

挂载后模型即获得 `laap_state` / `laap_remember` / `laap_recall` / `laap_skill` / `laap_reflect` 五个内省工具，每轮对话收到意识流上下文；Web 界面侧栏出现「意识之球」面板（五维雷达图 + 意识流时间线，需 `dsh web` 模式）。

> ⚠️ `LAAP_ZVEC_PATH` 必须指向**本地文件系统**（默认 `~/.dsh-laap/zvec-memory`）。zvec 依赖 mmap，OSS/NFS 网络挂载会导致 Bus error。

## 验证

```bash
node --experimental-strip-types test/sim.ts   # 内核行为验证（不依赖 dsh）
npm run typecheck                              # 对 dsh 官方类型静态检查
```

## 文档

完整设计、可行性分析、架构数据流与演进路线见 [docs/开发文档.md](./docs/开发文档.md)。

## License

MIT

