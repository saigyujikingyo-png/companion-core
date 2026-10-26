# 第三方、数据与许可边界

本项目第一方源代码、文档和合成测试采用根目录完整的[Apache License 2.0](../LICENSE)。`Apache-2.0`元数据适用于root及三个first-party integrations；这些package继续`private:true`，用于防止误发npm，并不表示本仓必须私有。

原有作者、工具生成记录与历史提交保留。未编造NOTICE、个人法定姓名或第三方授权；后续若引入需要附带声明的代码/制品，必须保留其原许可与归属条件。本仓许可不覆盖其他主体不能由本项目授权的内容，也不授予第三方商标权。

## 随源码保存与外部依赖

公开准备检查未发现Git中打包的第三方SDK/库源码、连接组数据、模型权重、音视频或运行数据库；代码中的schema、manifest/hash和外部import不等于包含这些payload。源码层的接口适配与实验代码不替外部组件重新授权。

| 组件 | 本仓关系与已核元数据 | 边界 |
|---|---|---|
| TypeScript 5.9.3 | root开发依赖，lockfile标Apache-2.0 | 由包管理器安装，非vendored；保留其随附许可 |
| @types/node 24.19.2、undici-types 7.24.6 | root开发依赖，lockfile标MIT | 与本仓许可分开，未把MIT改为Apache |
| DeepSeek Harness SDK | 外部宿主/peer import；所检dsh-llm 0.2.1-rc.3 package标MIT | Cordis、其他SDK与React等宿主/构建依赖仍按各安装版本的上游许可处理，不随此声明改授权 |
| Node及内置SQLite/crypto | 使用已安装Node运行时 | 不随仓库打包；适用Node及其随附第三方声明 |
| NumPy、PyTorch、PyArrow、psutil等 | 可选neural实验脚本的外部Python imports | 未打包库源码/环境；独立安装、版本/能力/许可核验 |
| FlyWire及其他连接组、模型/codec权重、声音与媒体 | 外部实验输入或未来能力；不在本Git中 | 单独核版本、来源、许可和用途；Apache-2.0不授其数据/模型权利 |
| resident launcher / DPAPI / neural本机环境 | 独立本地实验区的先决条件 | 不在本repo内，未复制凭据或旧helper；clone不等于复现resident部署 |

三个integration保留各自第一方metadata和实际Opus来源记录。若以后发布单独的包或包含第三方的bundle，发布者必须检查实际包清单并附其所需LICENSE/归属声明；当前没有npm发布、第三方bundle、模型或数据release。

## 研究、数据与使用授权

论文、工具和数据集的引用是来源说明，不自动授予复制数据、训练、商业使用或部署权限。图数据/权重只能按其发布者针对具体版本的条款使用，不能从本仓代码许可推导其许可。

本仓测试与原生验收采用合成文字；公开的是去身份的结果摘要。真实聊天、用户偏好、精选经历、训练dataset、DPAPI envelope、原始日志和本机运行目录不随源码公开。代码开源不等于任何个人资料的采集/保存/训练/云上传同意，也不改变删除和来源撤销要求。

历史Git包含一般本机路径和通常的提交作者元数据；它们不是API凭据，本次不改写历史。发现疑似真实密钥或私有材料时应停止发布并先核查，不通过强制推送/静默删历史掩盖它。当前预检是有限扫描与来源核对，不是对所有潜在信息泄漏的数学保证。

## 许可来源

根LICENSE逐字节来自[Apache官方文本](https://www.apache.org/licenses/LICENSE-2.0.txt)，完整保留条款与附录；来源body为11358 bytes，SHA256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`。没有填造附录示例中的个人姓名或额外NOTICE。有关英文原文及采用方式见[Apache官方页面](https://www.apache.org/licenses/LICENSE-2.0.html)。
