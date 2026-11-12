<div align="center">

<img src="public/favicon.svg" alt="FlyNeuro" width="72" />

# FlyNeuro

**在浏览器中，观察果蝇如何感知与行动。**

果蝇具身神经仿真 · Binocular vision, olfaction & whole-CNS activity

[在线体验](https://zhaofanbo.com/flyneuro/) · [架构与模型边界](docs/ARCHITECTURE.md) · [部署指南](docs/DEPLOYMENT.md)

[![Build](https://github.com/FanboZhao/flyneuro/actions/workflows/check.yml/badge.svg)](https://github.com/FanboZhao/flyneuro/actions/workflows/check.yml)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-WebGL-222222?logo=threedotjs)

</div>

---

FlyNeuro 将树林场景、双眼视觉、气味场与神经活动放在同一个交互环境中。观察果蝇从叶面起飞、穿越树木、接近花朵与降落，同时查看复眼输入、FlyVis 响应和全中枢神经系统（CNS）的活动。

它是用于研究探索与可视化的浏览器原型。寻香适配器包含人工设定的感觉到神经驱动规则，身体采用浏览器动力学代理；行为尚未经过生物学验证。

## 探索什么

| 视图           | 内容                                                            |
| -------------- | --------------------------------------------------------------- |
| **环境与身体** | Three.js 林间场景、FlyBody 视觉网格、振翅与腿部动画、碰撞与降落 |
| **复眼**       | 左右头部相机，每眼采样 721 个复眼柱                             |
| **FlyVis**     | 每眼独立的视觉网络状态，45,669 个模型单元及细胞类型活动曲线     |
| **嗅觉**       | 随风扩散的近似气味羽流、左右触角采样、浓度梯度与相对风向        |
| **CNS**        | 165,122 个神经元、10,511,038 条连接的 LIF 网络及下降神经元读出  |

使用顶部控件暂停、继续或重置仿真，调节运行速度；通过侧栏切换复眼、FlyVis、嗅觉和 CNS 面板。

## 快速开始

需要 **Node.js ≥ 22.13.0**、**pnpm 11.19.0**，以及支持 WebGL 的桌面浏览器。

```sh
git clone https://github.com/FanboZhao/flyneuro.git
cd flyneuro
pnpm install --frozen-lockfile
pnpm dev
```

打开终端输出的地址，默认是 **http://127.0.0.1:5173/flyneuro/**。

所有模型与数据均包含在 `public/` 中，无需 API 密钥或后端服务。首次加载约需下载 40 MB 静态资源，请等待 CNS 初始化完成。

## 开发

```sh
pnpm dev          # 启动开发服务器
pnpm typecheck    # TypeScript 检查
pnpm test         # 气味场回归检查
pnpm build        # 构建到 dist-static/
pnpm preview      # 预览生产构建
pnpm format       # 统一源码与文档格式
pnpm check        # 顺序运行格式、类型、回归检查与构建
```

GitHub Actions 对 `main` 的推送和拉取请求执行相同检查。

## 项目结构

```text
flyneuro/
├── src/
│   ├── App.tsx               # 仿真状态、控制栏与面板编排
│   ├── main.tsx              # React 入口
│   ├── styles.css            # 主题与布局
│   ├── simulation/           # 三维场景、环境构造、常量与类型
│   ├── components/           # 全脑视图、活动面板及 UI 基础组件
│   └── lib/                  # 二进制解码、资源路径与样式工具
├── public/
│   ├── workers/              # FlyVis、CNS 与气味场计算
│   ├── data/                 # 网络权重、连接图与神经元注释
│   ├── models/               # 浏览器优化的 FlyBody 模型
│   └── licenses/             # 第三方许可文本
├── scripts/                  # 模型转换与气味场回归检查
├── docs/                     # 架构、模型边界与部署说明
└── vite.config.ts            # 静态构建与 /flyneuro/ 子路径
```

场景渲染位于主线程，神经网络和气味场计算由 Web Worker 承担。数据流和模块职责详见[架构说明](docs/ARCHITECTURE.md)。

## 部署到个人主页

正式演示挂载在 **[zhaofanbo.com/flyneuro/](https://zhaofanbo.com/flyneuro/)**，个人主页的中英文项目入口均已接入。

`main` 保存源码，`gh-pages` 保存静态构建产物。执行 `pnpm build` 后，将 `dist-static/` 同步到发布分支即可；源码推送不会自动更新演示。具体步骤见[部署指南](docs/DEPLOYMENT.md)。

## 来源与致谢

- **[TuragaLab/flyvis](https://github.com/TuragaLab/flyvis)** — 视觉网络与预训练模型来源。
- **[TuragaLab/flybody](https://github.com/TuragaLab/flybody)** — 果蝇身体的官方视觉网格。
- **[Lulzx/fly-brain](https://github.com/Lulzx/fly-brain)** — 连接图、神经元数据、浏览器 LIF 模型及 FlyVis 导出。

上游版本、资源修改与许可见 [Third-party notices](public/THIRD_PARTY_NOTICES.md) 和 [licenses](public/licenses)。模型能力与近似假设见[模型边界](docs/ARCHITECTURE.md#模型边界)。
