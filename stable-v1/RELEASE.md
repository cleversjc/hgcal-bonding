# 稳定版 1.3.0

2026-11-27 发布。OGP 报告、Cell 查询、Wire 反查、新增异常和逐根拉力记录统一使用现场核实的 LD V3 基础编号表。[打开稳定版](https://cleversjc.github.io/hgcal-bonding/stable-v1/)

| 报告与数据库 Cell | 完整线组 | OGP 定位线 |
| --- | --- | --- |
| C143 | W85–W87 | W85 |
| C142 | W337–W339 | W337 |

导入 PDF 或预处理 JSON 时直接按报告上的位点查表。每条检测取第一根 Wire，核对预览后保存。重复检测分别保留，同一模块的重复 Wire 会提示复核。

升级后沿用本机稳定版记录、原图和设置。旧清单中只有导入或编号对照历史的 C142、C143 待办，可在「预览编号更新」核对旧位点与新位点，逐条勾选后确认。原 Wire 和历次操作可追溯。已处理或人工修改过的条目沿用现场记录。

联网打开稳定版，看到「新版已就绪」后关闭所有稳定版窗口，再从原入口打开。在「映射与资料」可查看版本号 1.3.0。

PDF 图块保留原始分辨率和标注，展开后的 PNG 总量上限为 96 MiB。完整 ZIP 或 JSON 备份包含原图。「映射与资料 → 手机使用」提供离线缓存重建和本机数据清理。缓存重建会先下载并校验文件。清理 OGP 与异常记录时，可先导出 ZIP，再输入「删除」确认。

如需恢复 1.2.1，可用普通提交恢复备份中的 `stable-v1/` 目录，再通过同一入口发布。[稳定版 1.2.1 源码备份](https://github.com/cleversjc/hgcal-bonding/tree/backup/stable-v1.2.1-before-1.3.0/stable-v1)

回退前的稳定版 1.2.0 与开发版源码保存在 [备份分支](https://github.com/cleversjc/hgcal-bonding/tree/backup/before-ogp-c143-rollback-20261125)。

稳定版 1.1.0 的原始源码有独立备份分支 [`backup/stable-v1.1.0-before-1.2.0`](https://github.com/cleversjc/hgcal-bonding/tree/backup/stable-v1.1.0-before-1.2.0/stable-v1) 和既有标签 [`stable-v1.1.0`](https://github.com/cleversjc/hgcal-bonding/tree/stable-v1.1.0/stable-v1)，目录树为 `43bf71dfc3f7bd87868f0281812b079c83a01f54`。若需回到 1.1.0，可用普通提交将备份中的稳定版目录恢复到 `main`，继续使用现有入口和本机数据库。

现有内置 `previous-stable/` 兼容入口继续提供 1.0.0 数据交接和返回流程。「导出更新前快照」仍指从 1.0.0 首次迁移时保存的快照。
