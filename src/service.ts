/**
 * laap-service — cordis 适配层（被动适配器 / DIP 接线）
 *
 * 本文件是 dsh 宿主与框架无关内核之间的薄适配器：
 *  - 持有框架无关的 LaapKernel（src/core/kernel.ts），所有意识逻辑都在内核里；
 *  - 把 cordis 的 ctx.logger 适配为内核的 KernelLogger 端口并注入；
 *  - 把 cordis 的 ctx.effect 卸载钩子接到内核 dispose()（停心跳/存快照/关记忆）；
 *  - 以 ctx.laap 暴露与历史完全一致的公开面（engine/monitor/memory/restoredFrom
 *    + perceive/saveNow/learnSkill/matchSkills/report/uiSnapshot），
 *    供 laap-tools / laap-hooks / laap-prompt / laap-ui-host 及第三方插件 inject 使用。
 *
 * 配置优先级与环境变量覆写逻辑在 service-plugin.ts（插件入口）处理；
 * 本类只接收已解析好的 LaapKernelOptions。
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { LaapKernel, type LaapKernelOptions } from './core/kernel.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    laap: LaapService
  }
}

export class LaapService extends Service {
  static readonly provide = 'laap'

  private kernel: LaapKernel

  constructor(ctx: Context, cfg: LaapKernelOptions) {
    super(ctx, LaapService.provide)
    const cordisLog = ctx.logger('laap')
    this.kernel = new LaapKernel({
      ...cfg,
      // 端口适配：cordis logger → 内核 KernelLogger
      logger: {
        info: (m) => cordisLog.info(m),
        warn: (m) => cordisLog.warn(m),
      },
    })
    // 生命周期适配：cordis effect 卸载 → 内核 dispose（停心跳 + 存快照 + 关 zvec）
    ctx.effect(() => () => this.kernel.dispose())
  }

  // ── 子系统只读访问（与历史 ctx.laap.* 访问面一致）──
  get engine() { return this.kernel.engine }
  get bus() { return this.kernel.bus }
  get monitor() { return this.kernel.monitor }
  get memory() { return this.kernel.memory }
  get restoredFrom() { return this.kernel.restoredFrom }

  // ── 内核能力委托 ──
  perceive(event: Parameters<LaapKernel['perceive']>[0]) {
    return this.kernel.perceive(event)
  }

  saveNow(): void {
    this.kernel.saveNow()
  }

  learnSkill(name: string, howto: string) {
    return this.kernel.learnSkill(name, howto)
  }

  matchSkills(context: string, topk?: number) {
    return this.kernel.matchSkills(context, topk)
  }

  report() {
    return this.kernel.report()
  }

  uiSnapshot() {
    return this.kernel.uiSnapshot()
  }
}
