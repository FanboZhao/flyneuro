# FlyVis Observatory

浏览器中的果蝇具身视觉与寻香仿真：在树林中观察 FlyBody 果蝇起飞、避障、接近花朵与降落，同时查看复眼、FlyVis 和全 CNS 神经活动。

**在线演示：[flyvis-observatory.zhaofanbo618.chatgpt.site](https://flyvis-observatory.zhaofanbo618.chatgpt.site/)**

## 当前功能

- Three.js 树林场景、散布的树木与多朵气味源花；树干碰撞包含机翼拍动的水平扫掠范围。
- 来自 FlyBody 官方视觉网格的浏览器优化模型，带机翼、起飞收腿与降落伸腿动画。
- 两台头部相机生成左右眼画面，每眼采样 721 个复眼柱，送入独立的 FlyVis 网络状态。
- 每眼 45,669 个 FlyVis 节点；全 CNS 使用 165,122 个神经元和 10,511,038 条连接的 LIF 网络。
- 连续气味源、随风扩散的平均羽流与移动气味团，提供左右触角采样、浓度梯度与风向信号。
- 跟随相机，以及复眼、FlyVis、嗅觉和 CNS 面板；支持暂停、重置和速度调节。

## 模型边界

这是研究探索与可视化原型。FlyVis 活动通过映射进入 CNS，身体动作读取 CNS 中下降神经元的滤波发放；但寻香适配器仍包含人工设定的感觉到神经驱动规则。它不是已经验证的、完全由生物大脑自主产生行为的果蝇模型。

FlyBody 在本项目中提供视觉身体网格，身体位移、碰撞和关节动画由站点代码实现，尚未接入完整的 MuJoCo 动力学、肌肉或关节力矩控制。气味场是浏览器规模的近似模型，不是 CFD 求解器。神经模型时间和场景时间可能以不同速度推进。

## 本地运行

需要 Node.js >= 22.13.0，以及 `package.json` 指定版本的 pnpm。

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

打开终端输出的本地地址，默认是 `http://localhost:5173/`。模型权重、连接图和身体模型都已包含在 `public/` 中；不需要 API 密钥。首次加载会读取数十 MB 的神经数据，建议使用桌面浏览器并启用 WebGL。

```sh
# 类型检查
pnpm exec tsc --noEmit

# 气味场回归检查
node scripts/test-odor-field.mjs

# 构建 Cloudflare Workers 兼容产物
pnpm build

# 在本地预览构建产物
pnpm start
```

生产演示托管于 Sites；仅把源码推送到 GitHub 不会自动更新演示。重新部署与运行环境说明见 [Sites runtime reference](docs/SITES_RUNTIME.md)。GitHub 副本的 `.openai/hosting.json` 仅保留本地构建配置；在自己的 Sites 项目部署时，需要由 Sites 注册工具写入你自己的 `project_id`。

## 源码位置

| 位置 | 内容 |
| --- | --- |
| `app/page.tsx` | 场景、身体、碰撞、传感器和界面 |
| `public/workers/flyvis-worker.js` | 左右眼 FlyVis 推理 |
| `public/workers/cns-worker.js` | 全 CNS LIF 仿真及神经驱动适配 |
| `public/workers/odor-worker.js` | 气味场与触角采样 |
| `public/data/` | 预训练权重、连接图及神经元注释 |
| `public/models/flybody-fly.glb` | 优化后的 FlyBody 视觉模型 |
| `scripts/build-flybody-model.mjs` | 从官方模型资源生成浏览器模型 |

## 来源与许可

本项目参考并使用 [TuragaLab/flyvis](https://github.com/TuragaLab/flyvis)、[TuragaLab/flybody](https://github.com/TuragaLab/flybody) 和 [Lulzx/fly-brain](https://github.com/Lulzx/fly-brain)。第三方资源的上游提交、修改说明与许可见 [THIRD_PARTY_NOTICES](public/THIRD_PARTY_NOTICES.md) 和 [public/licenses](public/licenses)。

本次 GitHub 导出对应在线站点第 26 版，源代码提交为 `2e60842cb71eea3bf949ba511f310baeea892351`。运行代码和模型数据保持该版本，另外补充了本说明并移除了本地生成文件和原站点的托管标识。
