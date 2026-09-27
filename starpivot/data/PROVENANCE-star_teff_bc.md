# `SpType → T_eff` 与 `SpType → BC` 两张标定表：取数证据

本文件回答一个问题：**`star_teff_bc.json` 里的每一个数，从哪来、能不能自己复算、它是什么性质。**

规矩只有一条（与 `data/PROVENANCE.md` 同）：**观测量、标定值、模型参数三类必须分开写。**
本文件里的两张表**全部是标定值**（某一光谱型的平均定标值），**没有一个是观测值**，
也没有一个是针对某颗具体恒星的测量——这一点在页面上必须如实标注。

---

## 1. 取数记录（可复现）

| 项 | 内容 |
|---|---|
| 数据集 | `A Modern Mean Dwarf Stellar Color and Effective Temperature Sequence` |
| 作者 / 机构 | Eric E. Mamajek，University of Rochester（物理与天文系） |
| 版本 | **2022.04.16**（版本号印在文件第 4 行） |
| 请求 URL | `http://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt` |
| 实际落地 URL（跟随跳转后） | `https://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt` |
| 取数时刻（UTC） | **2026-09-27T13:53:48Z** |
| HTTP 状态 | `200` |
| Content-Type | `text/plain` |
| 原始字节数 | **55 680** |
| **sha1** | `c1ad104bc4cc5b9ffa13a479fbabdff44dd96843` |
| sha256 | `1de2edeec17bb3346e0e4e70b999de5ee29947df38474e64cddb7cfacc164b7f` |

**取数命令（逐字）**：

```bash
curl -sS -L --max-time 60 \
  -o EEM_dwarf_UBVIJHK_colors_Teff.txt \
  "http://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt"
sha1sum EEM_dwarf_UBVIJHK_colors_Teff.txt
# c1ad104bc4cc5b9ffa13a479fbabdff44dd96843
```

### 1.1 署名 / 引用要求（**这是硬要求，不是客套**）

原始文件头部自己写明了引用口径，逐字摘录：

```
# Much of the original content of this table was incorporated into
# Table 5 of Pecaut & Mamajek (2013, ApJS, 208, 9;
# http://adsabs.harvard.edu/abs/2013ApJS..208....9P), so that
# reference should be cited until an updated version of the table is
# published.  Parts of this table for A/F/G stars also appeared in
# Table 3 of Pecaut, Mamajek, & Bubar (2012, ApJ 756, 154).
```

文件末尾另有：

```
# Please email me if you use the table in your research and/or have
# any questions. - EEM
```

因此要求是两条：

| 要求 | 内容 |
|---|---|
| 必须引用 | Pecaut & Mamajek (2013), ApJS 208, 9；A/F/G 部分另引 Pecaut, Mamajek & Bubar (2012), ApJ 756, 154 |
| 作者请求 | 若用于研究，请邮件告知作者（`- EEM`，文件末行） |
| 许可证 | 文件内**未**声明 SPDX/License 字段；按学术惯例「引用即许可」使用，**未发现任何重分发禁止条款**。此处如实记为「未声明许可证」，而不是「已确认可自由分发」 |

---

## 2. 落地文件

| 项 | 内容 |
|---|---|
| 路径 | `starpivot/data/star_teff_bc.json` |
| 字节数 | **19 393** |
| sha1 | `e6fe9da82775a5e2052aa440e0d3d5adc38e4d9d` |
| 结构 | `tables.sptype_to_teff_K`（118 键）、`tables.sptype_to_bc_v_mag`（93 键）、`resolution`（`real_stars.json` 里 55 个原始串逐个的判定）、`coverage`、`source`、`lookup_rules` |

**这两张表是逐行抄下来的，不是挑出来的**：原始文件 118 行数据行全部落盘，
没有任何筛选或插值。所以任何人可以用第 1 节的 URL + sha1 重新解析一遍，与本文件逐位比对。
解析口径也写在 JSON 的 `lookup_rules` 里，只有一条：**第一列是键，第 2 列 `Teff` 进 `teff` 表，第 4 列 `BCv` 进 `bc` 表。**

### 2.1 原始文件里本身就缺的格子：照缺，不补

`BCv` 列在 **25 个键**上是字面 `...`（源文件自己的空值标记）：
`L6V L7V L8V L9V T0V T1V T2V T3V T4V T4.5V T5V T5.5V T6V T7V T7.5V T8V T8.5V T9V T9.5V Y0V Y0.5V Y1V Y1.5V Y2V Y4V`。

处理方式是：**留在 `sptype_to_teff_K` 里，从 `sptype_to_bc_v_mag` 里整个省掉**，
并在 `source_scope.bc_v_missing_in_source` 里列出来。**没有填 0，没有插值，没有拿邻行顶替。**
（这 25 个键与 `real_stars.json` 的 60 颗无关——它们都是 L/T/Y 型褐矮星。）

---

## 3. 这两张表的适用范围（**别把它当成通用恒星标定表**）

源文件题目里那个 **Dwarf** 是当真的。它的 118 个键**全部是光度级 V（主序）**，
从 `O3V` 到 `Y4V`，**一行 III、II、Ib、Ia 都没有**。这一点是实测出来的，不是读题名猜的：
把 118 个键逐个取出，末字符全部落在 `*V` 上。

| 源文件覆盖 | 源文件**不**覆盖 |
|---|---|
| 光度级 V（主序），光谱型 O3–M9 加 L/T/Y | 光度级 IV、III、II、Ib/Iab/Ia |
|  | Wolf-Rayet（W 型） |
|  | 复合光谱（`+` 或 `comp`） |

**这一条直接决定了第 5 节的覆盖率**，也是本次取数最重要的结论。

---

## 4. 太阳锚点验算（判据，现场独立复算）

链：`SpType → T_eff → BC → M_bol → L`。全程只用落盘的两张表里的数，加上题设输入。

| 步 | 量 | 值 | 来源 |
|---|---|---|---|
| 1 | 光谱型 | `G2V` | 题设（太阳锚点） |
| 2 | `T_eff` | **5770 K** | 查表 `sptype_to_teff_K["G2V"]` |
| 3 | `BC_V` | **−0.085 mag** | 查表 `sptype_to_bc_v_mag["G2V"]` |
| 4 | `M_V` | **4.83** | 题设给定（**不是**表里的数） |
| 5 | `M_bol` | **4.745** | `M_bol = M_V + BC_V = 4.83 + (−0.085)` |
| 6 | `M_bol,☉` | **4.74** | IAU 2015 nominal（题设口径） |
| 7 | 指数 | **−0.002** | `(4.74 − 4.745) / 2.5 = −0.005/2.5` |
| 8 | `L` | **0.995405 L☉** | `10^(−0.002) = 0.995405` |
| 9 | 偏差 | **−0.4595 %** | `(0.995405 − 1) × 100 %` |
| — | **判定** | ✅ **达标**（要求 ±2 %） | |

**与公认值的对照（也要写清楚，不能只报达标的那一个数）**：

| 量 | 本表给出 | 公认 | 差 |
|---|---|---|---|
| `T_eff`（太阳） | 5770 K | ≈ 5772 K | −2 K（**−0.0347 %**） |
| `BC_V`（太阳） | −0.085 mag | ≈ −0.07 mag | −0.015 mag |

**关于 `T_eff` 那 2 K**：源文件在 `G2V` 行给的是 **5770 K**，而它自己的说明文件
（见第 6.1 节的 `spt/G2V.txt`）里写的是 `=> adopt Teff(G2V) = 5770 K`，
同时列出了 `Teff(G2V) = 5772+-1 K ; Sun (Mamajek12)` 这一条。
即：**太阳本身是 5772 K，G2V 这一型的定标均值被取整到 5770 K**。两者差 2 K，可忽略。

**关于 `BC_V` 那 0.015 mag**：源文件**明确采用 −0.085**，并在 `spt/G2V.txt` 里给了理由
（校准到 Casagrande+2018 并置于 IAU 2015 测光系统，且专门用一段论证 Bakis & Eker (2022)
的 `BCv(G2V)=+0.078` 与实测不符）。**我们不改成 −0.07**——那是「记忆里的公认值」，
不是本轮取到的数据。作为敏感性检查，若强行用 −0.07：

```
BC = -0.070 → M_bol = 4.760 → L = 0.981748 L☉ → 偏差 −1.8252 %   （仍在 ±2 % 内）
BC =  0.000 → M_bol = 4.830 → L = 0.920450 L☉ → 偏差 −7.9550 %   （BC 一整项不能省）
```

**另外两个数字，也必须报，不能藏**：

1. **表里 `G2V` 行自己的 `Mv` 是 4.80，不是题设的 4.83。** 若用表自己的那一对
   `(Mv=4.80, BCv=−0.085)`：`M_bol = 4.715`，`L = 1.023293 L☉`，偏差 **+2.3293 %** ——
   **落在 ±2 % 之外**。差异全部来自「太阳 `M_V` 取 4.83 还是 4.80」这 0.03 mag 的口径分歧，
   与本链的计算无关。题设要求用 `M_V = 4.83`，按题设算是 **−0.4595 %，达标**；
   但把这个口径分歧如实写在这里，免得下一个看到 `+2.3 %` 的人以为算错了。
2. **`M_bol,☉ = 4.74` 是题设输入，不是本表推出来的**（本表推得 `M_bol = 4.745`）。
   把输入写清，避免「用自己推的值自证」。

---

## 5. `real_stars.json` 全部 60 颗的查表覆盖

**结果：命中 13 / 60（21.7 %），未命中 47 / 60。**
按唯一串计：55 个唯一 SpType 里，**10 个查得到，45 个查不到**。

### 5.1 查得到的 10 个串 / 13 颗（含判定方式）

| 原始 `SpType` | 判定 | 查表键 | 颗数 |
|---|---|---|---|
| `A1V` | exact | `A1V` | 2 |
| `A2V` | exact | `A2V` | 2 |
| `B8V` | exact | `B8V` | 2 |
| `B1V` | exact | `B1V` | 1 |
| `B7V` | exact | `B7V` | 1 |
| `A0V SB` | normalized_obs_note | `A0V` | 1 |
| `A3Vvar` | normalized_obs_note | `A3V` | 1 |
| `B3V SB` | normalized_obs_note | `B3V` | 1 |
| `A2Vm` | normalized_peculiarity | `A2V` | 1 |
| `B3Vp` | normalized_peculiarity | `B3V` | 1 |

判定规则（`lookup_rules`，只有三条，全部保守）：

1. `exact`：原始串**就是**表里的键。
2. `normalized_obs_note`：剥掉**不属于 MK 型**的尾巴（`var` / `SB` / `...` / `:`）后再匹配。
   这些尾巴说的是「变星 / 分光双星 / 备注被截断」，**不改变光谱型本身**。
3. `normalized_peculiarity`：剥掉**跟在光度级之后的 MK 特殊标记**（`p`/`m`/`e`/`n`）后再匹配。
   `B3Vp` 的 MK 型就是「温度级 B3 + 光度级 V + 特殊标记 p」，剥成 `B3V` 是**读法**，不是猜测。
4. 其余一律 `unresolved`，**不猜、不填默认值**。

第 2、3 条都与原始串一起记在 JSON 的 `resolution` 里（`status` + `key` + `reason` + `n_stars`），
所以「这一颗是按哪种判定查到的」随时可查，不需要读本文件。

### 5.2 查不到的 45 个串 / 47 颗，按原因分三类

| 原因 | 唯一串数 | 颗数 | 说明 |
|---|---|---|---|
| `class_not_in_source` | 35 | 37 | 该型**根本不在源文件里**（源只到光度级 V） |
| `ambiguous_class_range` | 6 | 6 | 串给的是**光度级区间**（`II/III`、`III-IV`、`IV-V`、`Ib-II` 等），取哪一端是我们的选择，**不替用户选** |
| `composite` | 4 | 4 | **复合光谱**（`+` 或 `comp`），单星标定表**不适用**——把双星混光说成一颗星的温度就是错的 |

**未命中的原始串（原样列出，未做任何改写）**：

**A. 源文件不含此光度级（35 个唯一串 / 37 颗）**

```
A0IV  A0m...  A0p  A1IV  A2IV  A8Ib
B0.5III  B0.5IV  B0.5Iavar  B0IV:evar  B0Ia  B1III  B2II  B2III  B2IV  B5Ia  B7III  B8Ia  B9p
F0Ib  F5Ib  F8Ia
K0III  K0III...  K0IIIb  K0IIIvar  K2III  K3III  K5III
M0IIIvar  M2Ib  M4III
O5IAf  O9.5II  O9.5Ib SB
```

**B. 光度级区间，有歧义（6 个唯一串 / 6 颗）**

```
B1II/III   F2III-IV   F5IV-V   F7:Ib-IIv SB   K0II-IIIvar   K4Ib-II
```

**C. 复合光谱，单星标定不适用（4 个唯一串 / 4 颗）**

```
F7V comp   K3III+B2V   M1: comp   WC8 + O9I
```

**两类必须点名的**：

- **`F7V comp` 特意没有按第 5.1 节第 2 条剥成 `F7V`。** 剥得掉，但剥了就是**错的**：
  `comp` 表示这个光谱是两颗星混出来的，`F7V` 那部分并不是「这颗星」的温度。
  所以它走 `composite` 分支，**宁可缺**。
- **`B9p`、`A0p`、`A0m...` 也没有剥成 `B9V`/`A0V`/`A0V`。** 这三个串**根本没有光度级**；
  要落到源表（全是 V）必须先**假设**它们是主序——那是一次假设，不是查表。**不假设，就是缺。**

### 5.3 这个覆盖率对上游意味着什么（一句话）

**这 60 颗是 `Vmag < 2.5` 的亮星，绝大多数是巨星/超巨星，而本表的源是纯矮星序。**
所以 47/60 查不到**不是抄错、也不是取数失败**，是**源的覆盖范围与样本不匹配**。
**验收表第 4 条里「参宿四 / 参宿七」那半句，用这一张表仍然做不到**（`M2Ib`、`B8Ia` 都是超巨星）。
下一节列出已经查过、但**本轮没有采用**的候选源。

---

## 6. 取不到 / 查过但未采用 / 未验证（如实列，**不含糊**）

### 6.1 已核实可取、但**没有采用**：Mamajek 的 `spt/` 逐型说明文件

| 项 | 内容 |
|---|---|
| URL | `http://www.pas.rochester.edu/~emamajek/spt/<SpT>.txt`，例：`K0III.txt`、`A0IV.txt`、`G2V.txt` |
| 实测 | 目录页 HTTP `200`，62 421 字节；共 **314** 个 `.txt`（含 III、IV、V 三级，**没有 II/Ia/Ib**） |
| 实测内容 | 含**明确采纳值**，例：`=> adopt Teff(K0III) = 4850K [updated 10/30/2020]` |
| **为什么没用** | ①**没有 BC**——三份抽样（`K0III` / `K5III` / `M0III`）全文检索 `BCv`、`BC(`、`Mbol`、`logL` **零命中**；只靠它得到 `T_eff` 而得不到 `BC`，`L` 仍然算不出来。②它是**逐型自由文本**（每份 40 KB 上下的标准星清单），不是机器可读表。 |
| 结论 | **记录在案，供下一轮决定**。若要补 III/IV 的 `T_eff`，这里是首选且与第 1 节同源（源文件自己写明「已把 `spt/` 的 Teff 并入本表」），但**只有 T、没有 L**。 |

### 6.2 **未验证**：Schmidt-Kaler (1982) 的 `T_eff` / `BC_V` 三光度级表

这是最诱人的一条——它**正好有 V / III / I 三列**，含 `T_eff` 与 `BC_V`，
能覆盖 `M2Ib`、`B8Ia`（也就是验收第 4 条里缺的那两块）。

| 项 | 内容 |
|---|---|
| 题名 | *Table 3.7 The effective-temperature and bolometric-correction scales*，注明 `SOURCE: From data published in Schmidt-Kaler (1982)` |
| 找到的两个落点 | `https://www.as.utexas.edu/~sj/old-a358-sp18/prereq/lec.a358-prereq.pdf`（3 432 142 字节）与 `https://www.as.utexas.edu/~sj/old-a358-sp06/lec3.pt2.pdf`（254 775 字节） |
| 实测（小的一份） | HTTP `200`、254 775 字节**下载完整**。解压出的全部文本共 **665 字符**，重建后逐字如下：`…Bolometric correction \(to go fro M_v to M_Bol\) for stars with different spectral types and luminosity classes \(V, III, I\). F stars which peak near V-band, have small BC.` —— **这张幻灯片的文字只有题注，没有表体**。表体（连同 `SOURCE: … Schmidt-Kaler (1982)` 那一行）落在**光栅图**里：该文件含 `/Image` 34 处、`CCITTFax` 13 处、`DCTDecode` 2 处，而 `Schmidt` / `3.7` / `SOURCE` 在文本层**零命中**。 |
| 实测（大的一份） | HTTP `200`，但**两次都没下全**：先前一次 90 秒超时（`Operation timed out after 90005 milliseconds with 1215736 out of 3432142 bytes received`）；后来一次放到 **3 309 568 / 3 432 142 字节（96.4 %）后被中止**，文件**截断、无 `%%EOF`**。它有文本层（可见 `BT` / `Tj` 算子），但用的是**子集字体编码 + 逐字拆分的 kerning 数组**（`[...(p)-0.38(e)-0.38(s)-3.76(...)]TJ`），且**未找到 `beginbfchar`（ToUnicode CMap）**；靠朴素关键词检索会漏（例如 `bolometric` 被拆成 `(b)(o)(l)…` 而检索不到）。 |
| 本机可用工具 | `pdftotext` / `mutool` / `gs` / `qpdf` **均不存在**（已逐个探测），python 侧 `pypdf` / `PyPDF2` / `fitz` / `pdfminer` / `pdfplumber` **均未安装**。 |
| **结论** | **未验证，未采用。** 我**没有**把它写进 `star_teff_bc.json`。这张表确实存在（题注证明了它的表头与范围：`luminosity classes (V, III, I)`），但**表体在本机可得的文件里是图片**，而本机没有 OCR，所以**我一个数字都没读到**——更谈不上字节数、sha1 与逐位复核。任何从别处（含搜索结果摘要）抄来的这组数字，都**不满足**「从哪个 URL、什么时候取的、原始字节数、sha1」这条要求。**如果需要一个覆盖超巨星的表，这是下一轮该正经解决的事**：优先找**原始文献的机器可读表**（VizieR / 期刊附表），而不是把讲义 PDF 送去 OCR —— 后者即使 OCR 成功，也仍然只是 1982 年印刷表的**二次转录**。 |

### 6.3 已核实可取、但**没有采用**：Martins & Plez (2006) 的 O 星 BC 表

| 项 | 内容 |
|---|---|
| 表 | VizieR `J/A+A/457/637/table3`，经 `https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync` 查询，HTTP `200` |
| 实测列 | `recno, SpType, UMAG, BMAG, VMAG, JMAG, HMAG, KMAG, (U-B)0, …, BCU, BCB, BCV, BCJ, BCH, BCK`——**按 SpType 逐型给 `BCV`**（已实测取到前 8 行：`O3V … O7.5V`） |
| **为什么没用** | 只给 **BC，不给 `T_eff`**。补了它仍然缺温度，而且它是 **O 星专用**、用的是 Martins+2005 的理论温度标尺，与第 1 节的矮星表**不是同一条温度标尺**——混进来就违反了「同一条链只用一份口径」。 |

### 6.4 主动搜过、**没找到**：一份「全光度级 + 同时含 T_eff 与 BC」的表

在 VizieR TAP 的元数据表上直接查过（`TAP_SCHEMA.tables`，全部 HTTP `200`），
以下检索**均返回 0 行**：

```sql
select table_name, description from TAP_SCHEMA.tables where description LIKE '%bolometric%' AND description LIKE '%spectral%'
select table_name, description from TAP_SCHEMA.tables where description LIKE '%temperature scale%'
select table_name, description from TAP_SCHEMA.tables where description LIKE '%Teff%' AND description LIKE '%luminosity class%'
select table_name, description from TAP_SCHEMA.tables where description LIKE '%supergiant%' AND description LIKE '%temperature%'
```

命中率最高的两条也只是：`J/PAZh/34/21/table1`（有 `B-V` 与 `M`，按光度级 I/III/V——**没有 `T_eff`、没有 `BC`**）、
`J/A+A/611/A11/tableb0`（Casagrande/Chiavassa 的 `BC(T_eff, log g, [M/H])` 格点——**要先用别的来源拿 `log g`，那又是一次假设**）。

**结论：截至 2026-09-27，没有找到「按 SpType 索引、同时给出 `T_eff` 与 `BC_V`、且覆盖 I–V 全光度级」的可取表。**
这不是没找，是找过没有——**如实记为「没找到」，不记为「不存在」**。

### 6.5 一条彻底的失败，原样报错

`https://api.figshare.com/v2/articles/search`（POST，想找 Mamajek 在 figshare 上的机器可读表）
返回 **HTTP 403**，报文原文只有 `<html><head><title>403 Forbidden</title></head>…`。
从站内页面 `https://sites.google.com/site/mamajeksstarnotes/...` 取数同样失败，`curl` 原文：
`curl: (7) CONNECT tunnel failed, response 502`。
两条都**没有**产出任何数据。

### 6.6 明确「未做」的事（免得有人以为做了）

- **没有**为了凑覆盖率而给任何未命中项填默认值、插值或邻行顶替。
- **没有**把 `T_eff` 与 `BC` 之外的列（`Mv`、`Mbol`、`logL`、颜色）抄进本次交付。
- **没有**改 `real_stars.json`、`real_exoplanets.json`、`viewer/`、`src/` 下的任何文件（只新增本节第 2 节与本节两个文件）。
- **没有**跑 `_runall.sh` / `_verify_all.ps1`，没有编译。

---

## 7. 复现方式

```bash
# 1) 取回原始表（唯一需要联网的一步）
curl -sS -L -o /tmp/EEM_dwarf_UBVIJHK_colors_Teff.txt \
  "http://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt"
sha1sum /tmp/EEM_dwarf_UBVIJHK_colors_Teff.txt
# 期望 c1ad104bc4cc5b9ffa13a479fbabdff44dd96843（55 680 字节，版本 2022.04.16）

# 2) 解析口径（与 star_teff_bc.json 的 lookup_rules 一致）：
#    跳过 ^# 行；第 1 列 = 键，第 2 列 = Teff(K)，第 4 列 = BCv(mag)；
#    非数字列（字面 "..."）按缺失处理，只从 BC 表省略。
#    例（G2V 行）：G2V  5770  3.761  -0.085  ...  →  teff=5770, bc=-0.085

# 3) 太阳锚点（期望 L = 0.995405 L☉，偏差 −0.4595 %）
python3 -c "print(10**((4.74-(4.83+(-0.085)))/2.5))"
```

**离线可复算的部分**：第 2、3 步只需要已落盘的 `star_teff_bc.json`，不依赖网络。
需要联网的**只有**第 1 步取数，URL 与 sha1 已在上表钉死。
