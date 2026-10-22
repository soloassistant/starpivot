# PROVENANCE — `starpivot/data/exo_mass_prov.json` 取数证据

任务 #57「取回行星质量出处与不确定度」。本文件记录 `exo_mass_prov.json` 里每一个数是从哪来的、什么时候取的、原始字节与 sha1，使任何第三方可以独立复算。

## 0. 结论摘要

- 19 颗行星在 NASA Exoplanet Archive `pscomppars` 表里**全部命中**，`pl_bmassj` 数值与 `real_exoplanets.json` **逐颗一致**。
- 按 `pl_bmassprov`（质量出处）原值分类：**`Mass` 16 颗、`Msini` 3 颗**。
- **全表实证：`pl_bmassprov` 只有 4 种取值，没有 `TTV` 这个字面值。** 凌星计时质量在 Archive 里被标成 `Mass`（绝对质量），不是 `Msini`。
- **`pl_bmassjlim` 不能当“是否下限”的判据**（891 颗 `Msini` 的 lim 是 0）。判据一律用 `pl_bmassprov`。
- 未验证项见第 7 节。

## 1. 取数环境与手段

- 机构 / 数据方：**NASA Exoplanet Archive**（NASA / Caltech IPAC，美国），网址 `https://exoplanetarchive.ipac.caltech.edu`
- 接口：TAP 同步口 `https://exoplanetarchive.ipac.caltech.edu/TAP/sync`，`format=csv`
- 手段：本机 `curl`（`-G --data-urlencode`，避免手写 URL 编码出错）。工具版本与命令见第 8 节。
- 表的选择：主取数用 `pscomppars`（Planetary Systems Composite Parameters），与 `real_exoplanets.json` 的来源表**同一张**，保证质量出处描述的是同一份综合值。`ps` 表（逐文献行）仅作旁证。

## 2. 逐条取数记录

| 编号 | 用途 | 取数时间 (UTC) | 原始字节数 | sha1 |
|---|---|---|---|---|
| E1 | 列名核实：ps 表真实列名（表头） | 2026-09-27T13:47:14Z | 6936 | `f71aa771eab50a408b767555eed9a5f9675ab05b` |
| E2 | 列名核实：pscomppars 表真实列名（表头） | 2026-09-27T13:47:20Z | 20235 | `06219d8f7b6cb1b0fadf97eaea4d614249c597fb` |
| E3 | ★主取数：19 颗行星的质量出处与误差（pscomppars） | 2026-09-27T13:47:27Z | 5765 | `c0be90badadcfd8b08afebe24355a72a5c578aa9` |
| E4 | 旁证：ps 表逐文献原始行（看是否存在第三种 provenance） | 2026-09-27T13:47:32Z | 19276 | `012590e72ce3339195e996f3fff2db90a9f71075` |
| E5 | 全表取值域实证：pl_bmassprov 的完整取值 | 2026-09-27T13:47:39Z | 83 | `ac1c5d65832eb0f9b2bc09cd7143be249c561ddd` |
| E6 | 交叉表实证：pl_bmassprov × pl_bmassjlim（用于否证 lim 可当判据） | 2026-09-27T13:47:45Z | 167 | `594b7dc4448c7389d6602856de3fd31b63e2b25c` |
| E7 | 官方列定义：TAP_SCHEMA 里 pl_bmass* 的描述文本 | 2026-09-27T13:47:51Z | 923 | `8ec9029b04cec73d84f1dabfeb0b0378c9665276` |

**来源 URL（与上表同序，逐条对应）**

- **E1** — 列名核实：ps 表真实列名（表头）
  - `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select%20top%201%20%2A%20from%20ps&format=csv`

- **E2** — 列名核实：pscomppars 表真实列名（表头）
  - `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select%20top%201%20%2A%20from%20pscomppars&format=csv`

- **E3** — ★主取数：19 颗行星的质量出处与误差（pscomppars）
  - `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select%20pl_name%2Chostname%2Cpl_orbper%2Cpl_bmassj%2Cpl_bmassjerr1%2Cpl_bmassjerr2%2Cpl_bmassjsymerr%2Cpl_bmassjlim%2Cpl_bmassjstr%2Cpl_bmassjformat%2Cpl_bmassj_solnid%2Cpl_bmassprov%2Cpl_bmassj_reflink%20from%20pscomppars%20where%20hostname%20in%20%28%27TRAPPIST-1%27%2C%27TOI-178%27%2C%27ups%20And%27%2C%2751%20Peg%27%2C%27Proxima%20Cen%27%29%20order%20by%20hostname%2Cpl_orbper&format=csv`

- **E4** — 旁证：ps 表逐文献原始行（看是否存在第三种 provenance）
  - `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select%20pl_name%2Cpl_bmassj%2Cpl_bmassjstr%2Cpl_bmassjlim%2Cpl_bmassprov%2Cpl_refname%20from%20ps%20where%20hostname%20in%20%28%27TRAPPIST-1%27%2C%27TOI-178%27%2C%27ups%20And%27%2C%2751%20Peg%27%2C%27Proxima%20Cen%27%29%20order%20by%20pl_name%2Cpl_bmassj&format=csv`

- **E5** — 全表取值域实证：pl_bmassprov 的完整取值
  - `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select%20pl_bmassprov%2Ccount%28%2A%29%20as%20n%20from%20pscomppars%20group%20by%20pl_bmassprov%20order%20by%20n%20desc&format=csv`

- **E6** — 交叉表实证：pl_bmassprov × pl_bmassjlim（用于否证 lim 可当判据）
  - `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select%20pl_bmassprov%2Cpl_bmassjlim%2Ccount%28%2A%29%20as%20n%20from%20pscomppars%20group%20by%20pl_bmassprov%2Cpl_bmassjlim%20order%20by%20pl_bmassprov%2Cpl_bmassjlim&format=csv`

- **E7** — 官方列定义：TAP_SCHEMA 里 pl_bmass* 的描述文本
  - `https://exoplanetarchive.ipac.caltech.edu/TAP/sync?query=select%20column_name%2Cdatatype%2Cdescription%20from%20TAP_SCHEMA.columns%20where%20table_name%3D%27pscomppars%27%20and%20column_name%20like%20%27pl_bmass%25%27&format=csv`

原始响应另存于本次工作目录 `.tmp_probe57/`（临时目录，不随交付保留）；因为**查询串完整写在这里**，任何人在同一接口重放即可拿回同一份字节并复核 sha1。

> 稳定性旁证：E1–E6 在 2026-09-27T13:44Z 与 13:47Z 各取一次，**两次 sha1 完全相同**，说明接口返回是确定性的（同一时刻的库状态）。已把这条写进结论，因为它决定了“事后复算 sha1 应当一致”这个判据是否成立。

## 3. 列名核实（不凭记忆）

先 `select top 1 *` 取真实表头，确认需要的列**确实存在**、且名字拼写如下（E1/E2，另见 E7 的官方描述）：

`ps` 表共 355 列、`pscomppars` 表共 703 列（由 E1/E2 的真实表头数出）。逐列核实：

| 列名 | ps（355 列） | pscomppars（703 列） | 官方描述（E7 原文 / 缺失时注明） |
|---|---|---|---|
| `pl_bmassj` | 有 | 有 | `Planet Mass or Mass*sin(i)` |
| `pl_bmassjerr1` | 有 | 有 | `Planet Mass or Mass*sin(i) [Jupiter Mass] Upper Unc.` |
| `pl_bmassjerr2` | 有 | 有 | `Planet Mass or Mass*sin(i) [Jupiter Mass] Lower Unc.` |
| `pl_bmassjsymerr` | **无** | 有 | —（TAP_SCHEMA 无描述行，未取到定义） |
| `pl_bmassjlim` | 有 | 有 | `Planet Mass or Mass*sin(i) [Jupiter Mass] Limit Flag` |
| `pl_bmassjstr` | 有 | 有 | `Planet Mass or Mass*sin(i)` |
| `pl_bmassjformat` | **无** | 有 | —（TAP_SCHEMA 无描述行，未取到定义） |
| `pl_bmassj_solnid` | **无** | 有 | —（TAP_SCHEMA 无描述行，未取到定义） |
| `pl_bmassprov` | 有 | 有 | `Planet Mass or Mass*sin(i) Provenance` |
| `pl_bmassj_reflink` | **无** | 有 | `Planet Mass or Mass*sin(i) [Jupiter Mass] Reference` |

> 注：`pl_bmassjsymerr` / `pl_bmassjformat` / `pl_bmassj_solnid` 三列**只存在于 pscomppars**，且 `TAP_SCHEMA` 里查不到它们的描述。这是为什么主取数必须用 `pscomppars` 而不是 `ps` —— `ps` 表连误差是否对称、取的是哪份解都拿不到。

官方描述原文（E7）：

```csv
column_name,datatype,description
"pl_bmassj","double","Planet Mass or Mass*sin(i)"
"pl_bmassjerr1","double","Planet Mass or Mass*sin(i) [Jupiter Mass] Upper Unc."
"pl_bmassjerr2","double","Planet Mass or Mass*sin(i) [Jupiter Mass] Lower Unc."
"pl_bmassjlim","int","Planet Mass or Mass*sin(i) [Jupiter Mass] Limit Flag"
"pl_bmassjstr","char","Planet Mass or Mass*sin(i)"
"pl_bmassj_reflink","char","Planet Mass or Mass*sin(i) [Jupiter Mass] Reference"
"pl_bmasse","double","Planet Mass or Mass*sin(i)"
"pl_bmasseerr1","double","Planet Mass or Mass*sin(i) [Earth Mass] Upper Unc."
"pl_bmasseerr2","double","Planet Mass or Mass*sin(i) [Earth Mass] Lower Unc."
"pl_bmasselim","int","Planet Mass or Mass*sin(i) [Earth Mass] Limit Flag"
"pl_bmassestr","char","Planet Mass or Mass*sin(i)"
"pl_bmasse_reflink","char","Planet Mass or Mass*sin(i) [Earth Mass] Reference"
"pl_bmassprov","char","Planet Mass or Mass*sin(i) Provenance"
```

要点：
- `pl_bmassjerr1` = **Upper Unc.**，`pl_bmassjerr2` = **Lower Unc.** —— 所以这两个值必须**分列**，不能合并成一个“±”。
- `pl_bmassprov` 官方描述仅一句 `Planet Mass or Mass*sin(i) Provenance`，**没给取值枚举**，所以取值域改用全表 `group by` 实证（E5）。
- `pl_bmassjsymerr` 与 `pl_bmassj_solnid` **在 TAP_SCHEMA 里没有描述行**（`like 'pl_bmass%'` 也没返回它们），故其语义没有官方口径可引 —— 见第 7 节。

## 4. 19 颗逐颗对齐

- 现有文件行星数：**19**
- Archive `pscomppars` 命中数：**19**
- 未命中列表：**（空，无未命中）**
- `pl_bmassj` 数值不一致列表：**（空，19/19 完全一致）**

| 行星 | 现有 pl_bmassj | Archive pl_bmassj | 一致 | pl_bmassprov | err1(+) | err2(−) | symerr | lim | 文献 (refstr) |
|---|---|---|---|---|---|---|---|---|---|
| TRAPPIST-1 b | 0.00432309 | 0.00432309 | ✅ | Mass | 0.00021710 | -0.00021710 | 1 | 0 | Agol et al. 2021 |
| TRAPPIST-1 c | 0.00411543 | 0.00411543 | ✅ | Mass | 0.00017620 | -0.00017620 | 1 | 0 | Agol et al. 2021 |
| TRAPPIST-1 d | 0.00122078 | 0.00122078 | ✅ | Mass | 0.00003776 | -0.00003776 | 1 | 0 | Agol et al. 2021 |
| TRAPPIST-1 e | 0.00217728 | 0.00217728 | ✅ | Mass | 0.00006922 | -0.00006922 | 1 | 0 | Agol et al. 2021 |
| TRAPPIST-1 f | 0.00326906 | 0.00326906 | ✅ | Mass | 0.00009754 | -0.00009754 | 1 | 0 | Agol et al. 2021 |
| TRAPPIST-1 g | 0.00415633 | 0.00415633 | ✅ | Mass | 0.00011956 | -0.00011956 | 1 | 0 | Agol et al. 2021 |
| TRAPPIST-1 h | 0.00102571 | 0.00102571 | ✅ | Mass | 0.00006293 | -0.00006293 | 1 | 0 | Agol et al. 2021 |
| TOI-178 b | 0.0030205 | 0.00302050 | ✅ | Mass | 0.00220245 | -0.00204513 | 0 | 0 | Leleu et al. 2024 |
| TOI-178 c | 0.01459907 | 0.01459907 | ✅ | Mass | 0.00163610 | -0.00166757 | 0 | 0 | Leleu et al. 2024 |
| TOI-178 d | 0.01636103 | 0.01636103 | ✅ | Mass | 0.00122708 | -0.00135293 | 0 | 0 | Leleu et al. 2024 |
| TOI-178 e | 0.0109493 | 0.01094930 | ✅ | Mass | 0.00091244 | -0.00091244 | 1 | 0 | Leleu et al. 2024 |
| TOI-178 f | 0.01771396 | 0.01771396 | ✅ | Mass | 0.00141586 | -0.00129000 | 0 | 0 | Leleu et al. 2024 |
| TOI-178 g | 0.01384395 | 0.01384395 | ✅ | Mass | 0.00122708 | -0.00116415 | 0 | 0 | Leleu et al. 2024 |
| ups And b | 0.6876 | 0.68760000 | ✅ | Msini | 0.00440000 | -0.00440000 | 1 | 0 | Curiel et al. 2011 |
| ups And c | 13.98 | 13.98000000 | ✅ | Mass | 2.30000000 | -5.30000000 | 0 | 0 | McArthur et al. 2010 |
| ups And d | 10.25 | 10.25000000 | ✅ | Mass | 0.70000000 | -3.30000000 | 0 | 0 | McArthur et al. 2010 |
| 51 Peg b | 0.61 | 0.61000000 | ✅ | Mass | 0.06000000 | -0.05000000 | 0 | 0 | Cont et al. 2026 |
| Proxima Cen b | 0.0033194 | 0.00331940 | ✅ | Msini | 0.00017305 | -0.00017305 | 1 | 0 | Suárez Mascareño et al. 2025 |
| Proxima Cen d | 0.00081805 | 0.00081805 | ✅ | Msini | 0.00011956 | -0.00011956 | 1 | 0 | Suárez Mascareño et al. 2025 |

## 5. 分类统计（按 `pl_bmassprov` 原始字段值）

**本批 19 颗**出现的取值（原样）：

| pl_bmassprov 原值 | 行星数 | 行星 |
|---|---|---|
| `Mass` | 16 | TRAPPIST-1 b, TRAPPIST-1 c, TRAPPIST-1 d, TRAPPIST-1 e, TRAPPIST-1 f, TRAPPIST-1 g, TRAPPIST-1 h, TOI-178 b, TOI-178 c, TOI-178 d, TOI-178 e, TOI-178 f, TOI-178 g, ups And c, ups And d, 51 Peg b |
| `Msini` | 3 | ups And b, Proxima Cen b, Proxima Cen d |

**全表实证取值域**（E5，`select pl_bmassprov,count(*) ... group by`，覆盖 pscomppars 全部条目）：

| pl_bmassprov 原值 | 全表行星数 | 对“是不是下限”的含义 |
|---|---|---|
| `M-R relationship` | 2970 | 由质径关系推得，**不是实测质量** |
| `Mass` | 2462 | **绝对质量**，不是下限 |
| `Msini` | 925 | m·sin i，**是下限** |
| `Msin(i)/sin(i)` | 15 | 已假定/已知 sin(i) 后由 m·sin i 反推的绝对质量 |

> **本批 19 颗只出现 `Mass` 与 `Msini` 两种**，没有 `M-R relationship`、没有 `Msin(i)/sin(i)`、**也没有 `TTV`**。
> 因此允许说的只有：16 颗是绝对质量（`Mass`）、3 颗是下限（`Msini`）。**不许把这 16 颗说成“下限”，也不许把这 3 颗说成“实测质量”。**

### 5.1 附带发现：`pl_bmassjlim` 不可用作判据

交叉表（E6，全表）：

```csv
pl_bmassprov,pl_bmassjlim,n
"M-R relationship",0,2970
"Mass",-1,11
"Mass",0,2230
"Mass",1,221
"Msin(i)/sin(i)",0,15
"Msini",-1,2
"Msini",0,891
"Msini",1,1
"Msini",,31
```

读法：`pl_bmassprov='Msini'`（真·下限）的 925 颗里，有 **891 颗 `pl_bmassjlim=0`**；反过来 `pl_bmassprov='Mass'`（绝对质量）里有 **221 颗 `pl_bmassjlim=1`**。本批 19 颗更是 `lim` 全为 0。

**结论**：`pl_bmassjlim` 与“该值是不是下限”不对应，**不能拿它做下限判据**；一律用 `pl_bmassprov`。（该列官方语义本身也未能证实，见第 7 节。）

## 6. 负样本论证：把 TRAPPIST-1 b 标成“下限”是错的

取回的真实字段值（E3，`pscomppars`）：

| 行星 | pl_bmassj | **pl_bmassprov** | err1(+) | err2(−) | lim | 文献 (refstr) |
|---|---|---|---|---|---|---|
| TRAPPIST-1 b | 0.00432309 | **Mass** | 0.00021710 | -0.00021710 | 0 | AGOL_ET_AL__2021 |

论证：

1. TRAPPIST-1 b 的 `pl_bmassprov` 实测值是 **`Mass`**，而“下限（视向速度 m·sin i）”这一说法在同一个字段里对应的值是 **`Msini`**。
2. 两者是**互斥取值**：`Mass` 表示自洽的绝对质量，`Msini` 才表示 m·sin i 下限。因此把 TRAPPIST-1 b 标成“下限”，**与 Archive 返回的真实字段值直接矛盾** —— 这条错误标注是能被机器判据抓到的（判据：`prov != 'Msini'` 时禁止出现“下限/m·sin i”字样）。
3. 反向对照（同一字段、不同取值的正样本）：`ups And b` 的 `pl_bmassprov` 是 **`Msini`** —— 这才是货真价实的下限，说它“下限”是对的。可见该字段确实在区分方法，而不是恒为某一值。
4. **同时必须承认字段的边界**：`pl_bmassprov` **没有** `TTV` 这个值，它只说“`Mass`（绝对质量）”。所以**不能凭该字段断言“TRAPPIST-1 来自 TTV”**，只能断言“它不是 m·sin i 下限”。TRAPPIST-1 的 TTV 出身来自所引文献（`AGOL_ET_AL__2021`，即 Agol et al. 2021, PSJ 2, 1），不是来自 `pl_bmassprov` 的字段值。

> 这条负面论证的意义：下游判据若只查“有没有标成下限”是不够的 —— 它必须允许 `Mass` 而禁止 `Msini` 被说成绝对质量、同时禁止 `Mass` 被说成下限。两个方向的错都用同一个字段值卡住。

## 7. 未取到 / 未验证的项（如实列出）

1. **`pl_bmassjlim` 的官方语义未验证。** TAP_SCHEMA 只给描述 `Planet Mass or Mass*sin(i) [Jupiter Mass] Limit Flag`，**没有给取值枚举**；Archive 官方页面 `https://exoplanetarchive.ipac.caltech.edu/docs/API_pscomppars_columns.html` 本次取数时返回 **404 Not Found**（未取到）。因此本文件只记录它的**真实取值**（本批 19 颗全为 0；全表分布见 E6），**不解释它的含义**。第 5.1 节的结论（不能当判据）是**基于交叉表实测**得出的，不是基于文档。
2. **`pl_bmassjsymerr` 的定义未取到官方口径。** 该列在 `pscomppars` 表里存在，但 `TAP_SCHEMA.columns` 中**没有它的描述行**（E7 的 `like 'pl_bmass%'` 结果里没有它）。本文件写的“1 = 对称、0 = 非对称”是**在本批 19 颗上逐一实测归纳**（`symerr=1` 时 `|err1|==|err2|`，`symerr=0` 时不等，19/19 成立），**不是官方定义**，属未完全验证。
3. **“TTV”作为字段值不存在**（全表实证，E5）。凡看到“某颗质量是 TTV”的说法，其依据都**不在** `pl_bmassprov` 字段里。本文件没有、也不能从该字段论证任何行星是 TTV。
4. **`pl_bmassj_solnid` / `pl_bmassjformat` 未做解读**：本批 19 行的这两列均为空，未取到可用信息。
5. **Archive 是活库**：本文件的 sha1 对应 2026-09-27T13:47Z 的库状态。日后重放同一查询若字节变动，属数据方更新，不等于本文件记录有误；届时 sha1 不一致应当**重新取数**而不是改记录。

## 8. 复算方法

在主取数接口上用 curl 重放（`-G --data-urlencode` 会自动做 URL 编码）：

```bash
curl -s -G --max-time 120 \
  --data-urlencode "query=select pl_name,hostname,pl_orbper,pl_bmassj,pl_bmassjerr1,pl_bmassjerr2,pl_bmassjsymerr,pl_bmassjlim,pl_bmassjstr,pl_bmassjformat,pl_bmassj_solnid,pl_bmassprov,pl_bmassj_reflink from pscomppars where hostname in ('TRAPPIST-1','TOI-178','ups And','51 Peg','Proxima Cen') order by hostname,pl_orbper" \
  --data-urlencode "format=csv" \
  "https://exoplanetarchive.ipac.caltech.edu/TAP/sync" -o e3_massprov19.csv

sha1sum e3_massprov19.csv
# 期望：c0be90badadcfd8b08afebe24355a72a5c578aa9
```

本文件与 `exo_mass_prov.json` 的关系：JSON 是**数据**（每颗行星的质量/出处/不确定度），本文件是**该数据的取证与判读说明**。JSON 里 `source.raw_response_bytes` 与 `source.raw_response_sha1` 就是上表 **E3** 的值。
