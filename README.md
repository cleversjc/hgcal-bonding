# HGCAL Bonding 工作台 — GitHub Pages 部署包

适用于手机和电脑的 cell / wire 对照与 bonding 异常记录应用。使用者无需登录，生产记录和照片保存在当前设备、当前浏览器的 IndexedDB 中。

本包是可直接上传的静态网站文件，不是 APK 安装包。生成日期：2026-10-28。应用代码对应已发布源版本 `abc96c3aeddd6f0bcac407921ee3913d5b432ad3`；未改动编号表、位置图或业务逻辑。

## 一、部署前需要知道

- 发布和维护仓库的人需要 GitHub 账号；使用发布后的网站不需要 GitHub 或 ChatGPT 账号。
- GitHub Free 可以从公开仓库发布 Pages。公开仓库里的应用代码、编号表和参考图可被其他人查看。生产记录、照片、JSON 备份和 CSV 导出文件不要上传到仓库；它们不包含在本部署包中。
- GitHub Pages 可以提供 HTTPS，但能否在你的手机网络中不使用 VPN 访问，需要在发布后实际验证。换成 GitHub 托管不能保证任何地区、运营商或单位网络一定可达。
- 本包无需 npm、Node.js、数据库或自定义 GitHub Actions 工作流即可发布。

## 二、通过 GitHub 网页部署

1. 登录 GitHub，新建仓库，建议名称为 `hgcal-bonding`。使用免费 Pages 方案时选择 Public。可以勾选创建 README，随后用本包的 README 覆盖初始说明。
2. 在电脑上解压本压缩包，进入能看到 `index.html` 的目录。
3. 打开仓库的 Code 页面，选择 Add file → Upload files。将这个目录里的所有文件和 `assets` 文件夹一起拖入并提交到 `main` 分支。不要只上传 ZIP，也不要把整个应用再放进一层 `dist` 或同名目录。
4. 确认仓库根目录直接包含 `index.html`、`app.js`、`sw.js`、`manifest.webmanifest` 和 `assets` 文件夹。
5. 包内的 `.nojekyll` 是一个空文件，用于直接发布静态文件。如果电脑未显示它，或网页上传时未包含它，可在 GitHub 用 Add file → Create new file，在仓库根目录新建名为 `.nojekyll` 的空文件并提交。
6. 进入仓库 Settings → Pages，在 Build and deployment 下设置：

| 设置 | 选择 |
| --- | --- |
| Source | Deploy from a branch |
| Branch | main |
| Folder | / (root) |

7. 点击 Save，等待 Pages 发布完成。可在 Actions 页面查看发布任务结果。
8. 回到 Settings → Pages，通过 Visit site 打开 GitHub 返回的实际 HTTPS 地址，通常形式为 `https://你的用户名.github.io/hgcal-bonding/`。此处为网址格式示例；正式入口以 GitHub Pages 返回的实际地址为准。
9. 在 Pages 页面确认 Enforce HTTPS 已启用或由平台自动启用。保留网址末尾的 `/`，以后统一使用同一个正式入口。

## 三、发布后先做这几项检查

请用手机关闭 VPN，分别在现场 Wi-Fi 和需要使用的移动网络下检查：

1. 打开实际 Pages 地址，确认出现 Bonding 工作台，无登录要求，正反面图都能显示。
2. 正面输入 C73，应对应 W1–3；反查 W1，应定位 C73。
3. 切到背面，核对 H/G/L/K/J/I 六个位置；记录表单应按位置选择，不要求 wire 编号。
4. 等待页面显示“离线使用已准备”。这表示当前界面、编号表和位置图已经完整缓存。
5. 安装到主屏幕后，从桌面图标打开，建立一个明确标为测试的模块，保存一条测试异常和照片，再关闭、重开应用确认数据保留。测试记录可按应用流程标为已作废。
6. 从这个正式入口导出完整 JSON 备份，确认手机能保存文件。正式录入前完成文件保存验证。
7. 在离线准备完成后，关闭网络并从桌面图标重开，核对图、编号查询及已有测试记录。离线状态下也应能保存记录。

本部署包已完成相对路径检查，以及 GitHub Pages 仓库子路径下的离线逻辑模拟验证。手机现场网络、安装和离线使用仍需按上面的步骤实际检查；代码与模拟验证不代表已经完成这些手机端验证。

## 四、安装到手机

### Android

用 Chrome 打开发布后的 Pages 地址，选择浏览器菜单中的“安装”或“添加到主屏幕”（具体名称因版本而异）。也可打开应用首页“安装到手机”查看指引；浏览器提供安装能力时会出现安装按钮。

### iPhone

用 Safari 打开 Pages 地址，点击共享 → 添加到主屏幕；如果出现“作为网页 App 打开”，保持开启，然后添加。

先安装，再从桌面 Bonding 图标开始正式记录。首次从图标打开时保持网络可用，等待“离线使用已准备”。Safari 页面与主屏幕网页 App 的数据不应假定自动共享，必要时通过 JSON 备份迁移。

## 五、已有记录如何迁移

1. 从原来实际保存记录的浏览器或桌面图标入口打开旧版本。
2. 使用“完整备份”导出 JSON，保存到你自己选择的文件位置。
3. 从新的 GitHub Pages 正式入口（建议先安装到主屏幕）打开应用。
4. 通过“恢复备份”选择刚才的 JSON，核对模块、异常、照片和处理历史。
5. 核对迁移成功并保留备份后，再决定是否清理旧入口。

更换域名不会自动搬移浏览器数据。本应用不会自动把生产记录上传到 GitHub，也不会自动同步到另一台设备。不要清除旧入口的网站数据来尝试修复新入口空白的记录列表。

同一个 `用户名.github.io` 下的不同项目路径属于同一个源。当前数据库名称固定，因此请把本应用放在一个正式项目路径；不要把同一应用在同域下的两个路径当成数据相互隔离的生产与测试环境。如以后需要多个隔离实例，应先增加独立的存储和缓存命名空间。

## 六、日常使用与备份

选择或创建 Module ID，填写记录人和程序版本；正面通过 cell / wire 查询或点图定位，背面通过六个字母位置选择。新增异常可记录观察、计划与实际线数和照片，后续继续填写返修、复检说明。

记录人的姓名只是本地记录字段，不是登录账号。定期导出完整 JSON 备份；CSV 适合人工汇总，恢复应用数据应使用 JSON。清除网站数据、卸载网页 App 或更换设备可能导致本机记录丢失，因此应先备份。

离线缓存被浏览器清理后，需要再次访问这个 Pages 地址准备应用资源。应用静态资源缓存与生产记录是两个不同的存储用途。

## 七、以后更新

- 上传新版本文件到同一个仓库、同一个发布路径，GitHub Pages 会按所选分支重新发布。
- 修改任何应用静态资源时，维护者必须同时更新 `mobile-app.js` 和 `sw.js` 中的 `SHELL_VERSION`，并保持两处完全一致。
- 更新不会强制刷新正在填写的表单。保存当前记录、关闭所有旧版应用页面和桌面窗口，再从正式入口打开并保持联网。
- 覆盖更新不应清空记录；重要更新之前仍应先导出完整 JSON 备份。
- 404 时检查 `index.html` 是否确实在所选发布目录最上层，以及 Pages 任务是否成功；只上传 ZIP 不会自动解压成网站。

## 官方参考

- [GitHub Pages 的用途和项目网址](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)
- [从分支配置发布来源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)
- [创建网站与 .nojekyll](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [GitHub Pages 的 HTTPS](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)
- [Android Chrome 网页 App 安装](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=zh-Hans)
- [iPhone 网页 App 安装](https://support.apple.com/zh-cn/guide/iphone/iphea86e5236/ios)
- [WebKit 关于主屏幕 App 的本地存储](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/)
