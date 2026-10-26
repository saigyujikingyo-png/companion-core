# SP0 / SF0：有界 ScenePacket 与可读 JSON 交换

状态：**CONTRACT_IMPLEMENTED / INDEPENDENT_REVIEW_PASS**（2026-10-26）。本批实现纯 RAM 合同、不可变合成 catalog 和无压缩 JSON 完整性校验；未接 Store、真实来源权限、媒体、模型或持久格式。作者最终定向33/33、strict TS与合成demo通过，独立Astra max最终返验已通过；whole/CI以本批回执及对应提交Actions为准，当前不预报通过。不同层证据不相加。

## 冻结计划

1. 独立有界 JSON parser：字符串入口、先验 64KiB、重复键/Unicode/数值与递归预算。
2. 闭合 ScenePacket / ConceptRegistry / MappingProfile；claim 唯一值、对象绑定、精确版本与声明来源一致性。
3. SF0 自包含可读 envelope：独立逻辑/容器/codec 版本、全 payload 长度与 SHA-256、实例 catalog 固定。
4. 合成反例、demo、strict TS；作者定向验证后冻结，另一个 agent 独立审查，Sol 最后运行 whole。

## 作者验收矩阵

| 范围 | 必须检查 | 当前 |
|---|---|---|
| JSON | 字节/深度/节点/字符串上限、重复解码键、非有限/不安全整数/负零/下溢、孤立 surrogate | AUTHOR_PASS |
| 绑定 | object × attribute、关系 subject/object、claim revision、稳定旧 concept revision | AUTHOR_PASS |
| 声明 | scope/epoch/ref、origin、unknown、拒自行 independently_verified | AUTHOR_PASS |
| 空间/映射 | unknown/pixel2D、拒3D、完整 profile/prototype 同版、opaque residual 无 decoder | AUTHOR_PASS |
| 交换 | 完整65536/65537字节、组合节点/字符串预算、版本、roundtrip、hash/长度篡改、固定 catalog、深冻结 | AUTHOR_PASS |
| 隔离 | 独立纯 RAM 入口、固定错误码；无生产连接代码 | AUTHOR_PASS（不代表生产认证） |

本稿承接 [v0.6 表征设计](AEMC-V06-REPRESENTATION.md)和[存储设计](AEMC-STORAGE-FORMAT.md)。研究实验、压缩、持久接入与权限真实性不由本合同 PASS 代替。

## API 与真实性边界

```ts
const contract = new SceneContract(catalogJson);
const view = contract.read(packetJson);
const exchangeJson = contract.export(packetJson);
const restored = contract.import(exchangeJson);
// view/restored: { packet, catalog, assurance: 'NOT_AUTHENTICATED' }
```

四个入口严格要求原始 JavaScript string，不调用对象的 toString、getter、iterator 或 Proxy trap。构造时解析、验证并复制固定 catalog；后续修改 fixture 对象不改变实例。输出是新副本，所有嵌套对象/数组深冻结；输入为声明数据，没有 authority capability、回调、插件或资产读取。

catalog 只提供本实例内的引用/定义一致性。`declaredSources` 的 scope、epoch、origin、profile 的 training/calibration lineage 都是声明；它们不证明来源仍有效、真实身份、用户权限、事实真值、校准、资产存在或训练许可。`NOT_AUTHENTICATED` 始终返回，空 packet 也一样。没有实时 clock、TTL/revoke 查询、签名或 Store 连接。未来必须在交付/使用前接真正的当前 authority gate；不能把这个固定 catalog 实例重新解释为该权威。

本批不接受 `independently_verified`，只接受 `verification: "not_verified"`。修改某个合法 claim 的值仍可通过结构验证；这不是检测真实世界错误的测试。机械绑定拒绝“把 cup 的 color claim 挂到 plate”，不会识别“同一个 cup claim 的 red 被改成 blue”是真是假。观察、报告和推断是不同 origin 声明，不因成功导入而升级为独立证据。

## 闭合逻辑 schema v1

所有表中字段均必需；可未知字段写明确的 null 或 unknown variant，不接受未列字段。不自动补字段、不删未知字段后称等价。id/namespace/scope/opaque ref 为 1–128 个 ASCII 字符，匹配 `[A-Za-z0-9][A-Za-z0-9_.:-]*`；它们仅是名字，不作路径/URI 解析。普通文本禁止 C0/DEL，定义/claim text 上限2048 UTF-16 units，label text上限256。

`Ref = { id, revision }`，revision为正 safe integer。`ConceptRef = { namespace, id, revision }`。`Epoch = { generation, consentRevision }`两项均正 safe integer；在本协议中仅校验声明一致，不访问 Core epoch。`TrackRef = { device, streamEpoch, localTrackId, rev }`，两个数均正 safe integer。streamEpoch 不是权限 epoch，track 是观察假设，不等于现实 entity。

| catalog 字段 | 内容 |
|---|---|
| version | 精确1 |
| concepts | `{ ref:ConceptRef, kind, definition, labels:[{language,text}], status }`；kind为object_type/attribute/relation/value，status为active/retired；同revision精确匹配，旧定义/label不会由新revision覆盖；retired仍可被旧记录引用 |
| mappingProfiles | 下述完整引用声明；不证明资产hash或可用性 |
| prototypes | `{ ref, conceptRef, profileRef, dictionaryRef, decoderRef, quantizerRef }`；concept必须object_type，后三项与profile精确相等 |
| declaredSources | `{ ref, scopeRef, epoch, kind }`；kind为observation/report；同一Ref在本catalog唯一，跨scope同名不能借用 |

MappingProfile 必需字段：`ref, modelRef, checkpointRef, layer, activationKind, preprocessRef, tokenizerRef, pooling, dtype, normalization, encoderRef, saeDictionaryRef, prototypeDictionaryRef, decoderRef, quantizerRef, latentSpace, dimension, alignmentRef, trainingLineage, calibrationLineage`。带Ref的字段均为精确Ref；saeDictionaryRef/alignmentRef可null，lineage为catalog中声明来源Ref数组，dimension为1–4096整数，其余为上述id字符串。checkpointRef只是版本标识，未读取/计算模型checkpoint hash；本批不映射或解码任何数值。完整字段防止悄悄忽略某个版本依赖，不等于真实模型profile完整性已验收。

实际用于residual的profile，其trainingLineage/calibrationLineage每个Ref都必须在packet.sourceRefs中，并经过相同scope/epoch一致性检查。本批没有public/private profile授权合同，不能自行假设公共；空lineage仅代表未声明，仍NOT_AUTHENTICATED。未使用的catalog profile不自动成为packet来源，也不形成真实跨scope授权或训练许可。

| packet 字段 | 内容 |
|---|---|
| version / ref / scopeRef / epoch | 精确1、packet Ref、scope id、声明Epoch |
| occurredAt / recordedAt | occurredAt为null或非负safe integer；recordedAt为非负safe integer；单位为UTC epoch毫秒。未来occurredAt不自动拒绝，未知不补当前时间 |
| applicability | `{from,to}`，各为null或UTC epoch毫秒；两者已知时from≤to；本批不判当前有效性 |
| sourceRefs | 唯一Ref数组，每项必须与catalog中的scope/epoch一致 |
| tracks | `{device,streamEpoch,localTrackId,rev,sourceRef}`；sourceRef必须在packet中 |
| objects | `{id,typeClaim,trackRef,identityClaim,attributeClaims}`；trackRef/identityClaim可null；属性、类型、身份值只从claim读取 |
| claims | 下述唯一事实值声明 |
| relations | `{id,claimRef}`；subject/target只来自relation claim，不靠数组位置或自然语言猜角色 |
| anchors | `{id,claimRef,sourceRef,selector:{kind:"opaque",ref}}`；source必须列在该claim中；仅引用声明，没有读取fragment或独立核验 |
| geometry | unknown或下述pixel2D frame声明 |
| residuals | `{id,objectId,claimRefs,profileRef,prototypeRef,decoderRef,quantizerRef,opaqueRef}`；claimRefs非空且属于该对象；所有版本与profile/prototype及对象分类concept一致；仅opaque ref |

claim字段：`id, revision, kind, subject, predicate, value, origin, verification, sourceRefs, occurredAt`。每条claim至少一个来源；origin为observation/report/inference，前两者要求catalog source kind相同，inference可以引用两者。kind分类/身份时predicate=null；attribute/relation时predicate为对应kind的ConceptRef。每个claim必须且只能被一个object的type/identity/attribute槽或一个relation引用；不接未绑定隐藏claim。同对象同predicate只接一个属性claim；冲突声明/时间多版本需未来协议处理。

| claim kind | 允许的value |
|---|---|
| classification | `{kind:"concept",conceptRef}`（object_type）或unknown |
| identity | `{kind:"entity",scopeRef,ref}`（同packet scope）或unknown |
| attribute | unknown、`{kind:"text",text}`、`{kind:"number",number,unit}`、concept（value concept）或pixel2D矩形 |
| relation | `{kind:"object",objectId}`或unknown；subject和object必须存在，允许方向环/自环，不将关系图当provenance DAG |

unknown固定为`{kind:"unknown",reason:"not_observed"|"withheld"|"not_applicable"}`，不能带number/坐标或被prototype补成0。number的unit是非空id，不做单位换算。per-claim置信校准、独立verification、reconstructed origin、动作与时序偏序、affect写事实均未实现。

geometry是`{kind:"unknown"}`，或`{kind:"pixel2D",frameRef,width,height,units:"pixel",origin:"top_left",xAxis:"right",yAxis:"down"}`；frameRef必须是packet声明来源，图像宽高为1–1,000,000整数。pixel2D value为`{kind:"pixel2D",x,y,width,height}`，有限非负坐标，矩形必须在frame尺寸内。每轴检查`max(offset,size) ≤ extent`及`min(offset,size) ≤ extent-max(offset,size)`，不让极小正值被边缘浮点加法吞掉；允许边缘0宽/高。每个pixel2D claim还必须在自身sourceRefs中列出frameRef，适用于observation/report/inference，不能把同scope另一帧暗当坐标来源；本批无跨帧transform，unknown不补假frame。不接受3D字段、米单位或`calibrated3D`。这里只承载矩形坐标声明，不是SAM2非矩形ROI、视频轨迹提取、真实视觉理解、校准或检测质量。3D、数值residual、任何decoder和外部资产读取均不支持。

## 预算与数字/Unicode profile

每个原始JSON入口先检查 UTF-8 65,536 bytes。parser只读取JSON语法的有限token，单个字符串经过受限扫描后解码；不先对整个输入JSON.parse再无界遍历。所有输入和最终完整envelope（包括catalog、packet、anchors、profile、manifest）都受以下预算，`read`也构建并检查完整可导出envelope，不能先接受再由export截断。

| 项目 | 上限 |
|---|---|
| depth | 16，root为1，每个嵌套value加1 |
| nodes | 4096，每个value及每个object key各计1 |
| 单字符串 / 全部字符串 | 2048 / 32768 UTF-16 units，keys也收费 |
| 通用array / object | 256 items / 64 keys |
| 数字token | 128 UTF-16 units |
| objects / relations / anchors | 32 / 64 / 32 |
| claims / tracks / residuals | 128 / 32 / 32 |
| concepts / profiles / prototypes / catalog sources | 128 / 16 / 32 / 64 |
| Ref数组 / 每concept labels | 32 / 8 |

这些是独立上界，不保证最大组合或每种最大集合在总预算下都可达到。constructor与packet各自合格也可能在组合时被拒绝。原始空白/转义形式的入口字节另计；aggregate采用下面canonical完整envelope字节。内部暂存仍受这些有限输入上界约束，没有外部文件、解压或恢复循环。

此profile比[RFC8259](https://www.rfc-editor.org/rfc/rfc8259)更严：按解码后的key拒绝重复（`a`与`\u0061`重复），拒绝孤立surrogate、BOM、非JSON空白/语法。接受合法Unicode scalar，保留组合字符原样。并非声称RFC8259对上述全部情况都写MUST拒绝。

数值采用有限binary64；整数结果须在±(2^53−1)且原token数学值精确等于该整数，拒绝超界或小数舍入成整数。负零拒绝；非零mantissa下溢成0拒绝。非整数小数按binary64解析/转写，**不保证十进制逐位保真**。整数属性时间/尺寸再按各字段范围检查。未知值必须用unknown/null，不能用数值洗成0。

## SF0 identity JSON envelope v1

```text
{
  manifest: {
    logicalSchemaVersion: 1,
    containerProfile: "scene-json-envelope-v1",
    codecProfile: "identity-json-v1",
    canonicalization: "scene-canonical-json-v1",
    integrity: "sha256", payloadBytes, payloadSha256
  },
  payload: { catalog, packet }
}
```

输出是可读、紧凑、自包含JSON，不是二进制或压缩格式。规范化递归按解码后key的JavaScript UTF-16 code unit顺序排序；数组原顺序保留；primitive按JSON.stringify写出，不留格式空白，不做Unicode normalization。它是本项目显式profile，**不声称实现[JCS/RFC8785](https://www.rfc-editor.org/rfc/rfc8785)**。`payloadBytes`和小写hex SHA-256均针对UTF-8 canonical `{catalog,packet}`，不是原始输入JSON字节；格式化/键顺序变化不会改逻辑digest。manifest枚举/业务版本各自严格验证，manifest自身字节计总预算；不同版本拒绝，未知字段不丢弃。

import先做有界解析与闭合manifest校验，再重算payload长度/hash，核对embedded catalog与当前实例固定catalog规范字节完全相同，再重新做全部packet语义结构检查。完整性匹配不证明认证；另建新实例可接新的声明catalog，但不能沿用旧实例的版本定义。缺失依赖、同revision换label/profile、篡改hash或长度都不会被忽略。未实现签名、压缩、路径目录、资产下载、插件执行或模型decoder；opaque残差资产在包内没有bytes，基本claim可直接读取，但不能据此重建媒体/latent。

## 运行与后续门

`npm run demo:scene`以新合成fixture执行read/export/import，输出counts、`SCENE_CONTRACT_PASS`、`NOT_AUTHENTICATED`、`PERCEPTION_NOT_RUN`、`SEMANTIC_QUALITY_NOT_EVALUATED`、`PRODUCTION_NOT_CONNECTED`、`COMPRESSION_NOT_RUN`和`DECODER_NOT_RUN`，不打印正文、身份或hash。`npm run check`在既有三个demo后运行它。

作者focused包括parser、对象/角色绑定、版本漂移、unknown、2D/3D拒绝、opaque profile/lineage、逐claim帧绑定、极小正数矩形边界、closed字段、Proxy零回调、深冻结、hash/长度和总预算。最早RED是新增parser模块尚未存在；审查中的lineage/帧绑定/浮点边界反例另有实际RED→GREEN，作者GREEN与独立最终返验通过分层记录。后续whole/跨平台CI按发布提交另行记录；此前AR0和CI watchdog证据保持历史状态。

SP1/SF1的真实任务质量与同payload总成本、SP2跨encoder迁移、SF2崩溃/撤销/资产原子提交、AR0b持久schema/dispatcher/consumer baseline仍为独立未验门。当前没有真实感知、SAM/SAE/embedding、压缩收益、语义正确性、数据库迁移、训练、API或部署验收。
