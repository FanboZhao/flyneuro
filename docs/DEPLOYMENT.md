# GitHub 与个人主页部署

项目名称：**FlyNeuro**。源码仓库为 `FanboZhao/flyneuro`，正式演示地址为 <https://zhaofanbo.com/flyneuro/>。

## 发布结构

- `main`：可重新构建的源码、模型、锁文件和第三方许可。
- `gh-pages`：`pnpm build:static` 生成的静态文件。
- `FanboZhao/FanboZhao.github.io`：个人主页，配置自定义域名 `zhaofanbo.com`，并链接到 `/flyneuro/`。

使用独立项目仓库可以让演示位于个人域名的子路径，而不把数十 MB 模型复制到个人主页仓库。

GitHub Pages 应配置为从 `gh-pages` 分支根目录发布。`main` 的持续集成负责验证，不自动部署。

## 检查与构建

需要 Node.js >= 22.13.0 和 `package.json` 指定版本的 pnpm：

```sh
pnpm install --frozen-lockfile
pnpm exec tsc --noEmit
node scripts/test-odor-field.mjs
pnpm build:static
pnpm preview:static
```

访问预览地址的 `/flyneuro/`，等待神经数据加载，检查场景、复眼和 CNS 状态，以及暂停、继续、重置操作。需要支持 WebGL 的桌面浏览器。

## 更新正式演示

先提交并推送 `main`。在当前整理后的工作区中，从 `flyneuro/` 执行以下命令；同步前确保发布副本没有未提交的修改：

```sh
git -C ../publishing/gh-pages status --short
git -C ../publishing/gh-pages pull --ff-only origin gh-pages
rsync -av --delete --exclude=.git --exclude=.gitattributes dist-static/ ../publishing/gh-pages/
touch ../publishing/gh-pages/.nojekyll
git -C ../publishing/gh-pages add -A
git -C ../publishing/gh-pages diff --cached --stat
git -C ../publishing/gh-pages commit -m "Publish FlyNeuro static build"
git -C ../publishing/gh-pages push origin gh-pages
```

若没有变更，跳过提交步骤。新克隆可使用 `git clone --branch gh-pages --single-branch git@github.com:FanboZhao/flyneuro.git <发布目录>` 获取发布副本，然后将上述路径替换为该目录。

发布后等待 GitHub Pages 完成，访问正式地址并检查 Worker、`data/` 神经模型和 `models/flybody-fly.glb` 都能加载。仅检查首页 HTTP 200 不能代表仿真已初始化。

## 子路径与资源

`vite.static.config.ts` 的 `base` 为 `/flyneuro/`。Worker、模型和许可链接相对于应用目录解析。迁移路径时同步修改 Vite 的 base、`index.html` 的 canonical 和个人主页入口。

不要上传 `node_modules/`、`.env*`、缓存或原始 Sites 项目。保留 `public/licenses/`、`THIRD_PARTY_NOTICES.md` 和二进制模型文件；它们是运行和来源说明的一部分。
