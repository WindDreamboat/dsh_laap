# dsh-laap

LAAP 意识认知架构的 DeepSeek Harness 插件 Bundle：为 dsh Agent 装上持续演化的意识内核与 zvec 向量记忆。

- **意识引擎**：五维状态向量（压力/信心/好奇/连接/能量）微分方程演化 + PSI 五需求驱动 + 情绪微分信号；情绪脉冲经 EMA 沉淀为四级**心境**（negative / neutral / positive / elated），驱动感受质与外在情绪
- **全局工作空间**：CognitiveBus 显著性竞争 → 意识帧 → 每轮第一人称「意识流」注入提示词；外部感知/行动通道有显著性地板保证真实刺激入流，空闲空帧不产生意识内容
- **元认知**：L1 思维监控 + 贝叶斯置信度校准 + 六档思考模式切换（空闲无刺激时进入 intuitive 待机，不谎报思考模式、不污染模式成效归因）
- **记忆**：工作记忆（7±2 有界）+ [zvec](https://github.com/alibaba/zvec) 情景/语义向量层（WAL 持久化、标量过滤下推）
- **表现层推送架构**：内核只负责生成数据——事件驱动地通过 SSE 推送 `UiSnapshot`（POST 轮询自动兜底），前端只做映射（桌宠 FSM 查表、雷达/时间线渲染），不持有任何阈值或状态重算逻辑；快照 DTO 为双端共享的零依赖类型契约

## 快速开始

```bash
# 开发期临时挂载
pnpm dsh web --patch /绝对路径/dsh-laap/cordis.patch.yml

# 或安装到 Profile
dsh plugin --profile web add link:/绝对路径/dsh-laap
```

挂载后模型即获得 `laap_state` / `laap_remember` / `laap_recall` / `laap_skill` / `laap_reflect` 五个内省工具，每轮对话收到意识流上下文；Web 界面侧栏出现「意识之球」指示器（需 `dsh web` 模式），点击可切换两种形态：

- **悬浮面板**：五维雷达图（含经历帧计数）、心境指示、五需求条、意识流时间线（六档思考模式色带）；
- **意识桌宠**：立绘「茉茉」（绿幕素材实时色键抠图）或纯 SVG「意识团」可一键切换，状态由内核心境 + 认知模式经 FSM 查表映射（生气 / 专注 / 探索 / 开心 / 喜欢 / 休息 / 空闲），带 poke 唤醒与时间滞回防抖。

面板/桌宠数据全部来自内核 SSE 推送（`/api/laap/stream`），SSE 不可用时自动降级为 3 秒轮询。

> ⚠️ `LAAP_ZVEC_PATH` 必须指向**本地文件系统**（默认 `~/.dsh-laap/zvec-memory`）。zvec 依赖 mmap，OSS/NFS 网络挂载会导致 Bus error。

## 配置

**零配置即可运行**：默认使用内置 256 维哈希袋嵌入（纯 JS、0 依赖、离线、免 API Key）。

想接入真实语义嵌入（本地 Ollama 或 OpenAI 兼容接口）时，**无需改动仓库文件**：在启动目录（或 `~/.dsh`）放一个 `.env`（dsh 宿主启动时自动加载，已在 `.gitignore`）。配置优先级为 **环境变量 > `cordis.patch.yml` > 内置默认值**：

```bash
# 本地 Ollama（先 ollama pull nomic-embed-text）
LAAP_EMBED_PROVIDER=ollama
LAAP_EMBED_BASE_URL=http://localhost:11434/v1
LAAP_EMBED_MODEL=nomic-embed-text
LAAP_EMBED_DIMENSION=768
LAAP_NOVELTY_THRESHOLD=0.8

# 或 OpenAI 兼容接口
# LAAP_EMBED_PROVIDER=openai
# LAAP_EMBED_BASE_URL=https://api.openai.com/v1
# LAAP_EMBED_MODEL=text-embedding-3-small
# LAAP_EMBED_DIMENSION=1536
# EMBEDDING_API_KEY=sk-...
```

全部环境变量：`LAAP_ZVEC_PATH` / `LAAP_SENSITIVITY` / `LAAP_HEARTBEAT_MS` / `LAAP_NOVELTY_THRESHOLD` / `LAAP_EMBED_PROVIDER` / `LAAP_EMBED_BASE_URL` / `LAAP_EMBED_MODEL` / `LAAP_EMBED_DIMENSION` / `LAAP_EMBED_API_KEY_ENV`。

> ⚠️ **切换嵌入维度后必须删除旧向量库目录**（默认 `~/.dsh-laap/zvec-memory`）重建，维度不一致会导致写入失败。

## 验证

```bash
npx tsc --noEmit                               # L0 内核/宿主端类型检查
npx tsc -p tsconfig.web.json                   # L0 浏览器端类型检查
node --experimental-strip-types test/sim.ts    # L1 内核行为验证（不依赖 dsh）
node --experimental-strip-types test/host.ts   # L2 真实 cordis 挂载/快照续接
npm run build:client                           # 浏览器端改动后必须重建 lib/client.js
```

> 修改 `src/adapters/cordis/ui-client.tsx` 等浏览器端代码后**必须执行 `npm run build:client`** 并重启 `dsh web`——浏览器半区加载的是构建产物 `lib/client.js`，不热更新。

## 文档

完整设计、可行性分析、架构数据流与演进路线见 [docs/开发文档.md](./docs/开发文档.md)。

## License

MIT

