# viewer/ —— 前端（四页 + 两个数据脚本）

## 目录内容

| 文件 | 是什么 |
| --- | --- |
| `home.html` | 首页：这是什么 / 数据从哪来 / 怎么自己验 |
| `index.html` | 轨道递推 · 星下点 · 碰撞预警 |
| `universe.html` | N 体宇宙沙盒（最大的一页） |
| `kids.html` | 给小朋友的一页（正文不许出现术语） |
| `world.js` | Natural Earth 110m 陆地轮廓数据（星下点底图用） |
| `demo.js` | 轨道页上半页的**冻结样本** |
| `favicon.svg` | 站点图标（四页共用） |

## 依赖与出处

**本目录零外部依赖**：没有任何 CDN、框架、UI 库或字体外链，四页只引用上面这几个同目录文件。
实测证据：真 Chrome 加载四页，**外部请求数 0**（方法见
[`../docs/review-2026-09-28-frontend-a11y.md`](../docs/review-2026-09-28-frontend-a11y.md)）。

- **`world.js`** —— Natural Earth **110m** 陆地轮廓，**0.1° 取整、略去小岛**。
  来源 `natural-earth-vector`，**公有领域**。文件头写明打包进仓库的理由：
  *Bundled so the viewer works offline* —— 它存在的意义就是让星下点图**断网也能画**。
- **`demo.js`** —— 由 `tools/make_demo_data.py` 从 `starpivot propagate` 的**真实输出**生成，
  每个条目都是 **CLI 的逐字输出**（*what you see in the terminal is what this page plots*），
  含 `sso700` / `iss_drag` / `molniya` 三个场景。
  ⚠ **生成脚本已不在仓库里**，所以这份样本**只能复核、无法再生成**；
  复核手段是 `_probe_orbit_data.py`（逐位钉住那三条 `propagate` 命令）。
- **`favicon.svg`** —— 自绘（深空底 + 发光主星 + 轨道 + 行星）。**故意用文本 SVG**：
  网关的静态服务按 UTF-8 读文件，二进制图标（`.ico`/`.png`）会被读坏。
- **设计令牌** —— 四页共用 **48 个同名令牌**，改一个令牌要**四页一起改**。

## 数据从哪来

页面**一个数都不算**：物理全在内核，网关只做 argv 转发与 JSON 透传，前端只画内核回显的值。
观测值 / 标定值 / 模型参数的分线与出处见 [`../data/PROVENANCE.md`](../data/PROVENANCE.md)。

## 本地怎么跑

```bash
python tools/webapp.py --port 8765      # 然后打开 http://127.0.0.1:8765/
```

## 已知缺口

语义与无障碍方面对照 WCAG 的实测清单（`aria-live` 缺失、36 个 `<label>` 没有 `for`、
画布无替代文本、两处标题跳级）见
[`../docs/review-2026-09-28-frontend-a11y.md`](../docs/review-2026-09-28-frontend-a11y.md)。

> **状态：清单里的建议 1–4 已全部落地**（2026-09-28 晚，四页共 65 处改动，
> 全部是加属性或改一个非视觉标签，没有动过任何一条样式值）。
> 处置记录与三处刻意偏离原建议的理由见该文档 §6。
> 仍未验的是：没有用真读屏软件（NVDA / VoiceOver）实际听过。

## 网关侧的两个改动（2026-10-05）

`tools/webapp.py` 的 `_send()` 现在会做两件以前没做的事：

1. **gzip 压缩**（标准库 `gzip`，不引依赖）。以前边缘与网关都不压缩，
   `universe.html` 实测 264KB 原文；现在约 100KB（-63%），
   一次 1.53MB 的 `nbody` 回执降到约 441KB（-72%）。
2. **静态资源可缓存**：以前对一切响应都回 `Cache-Control: no-store`，
   边缘因此完全存不下东西（每次都是 `Eo-Cache-Status: MISS`）。
   现在静态页与 `data/*.json` 带 `ETag` + `max-age=300`，
   重复访问走条件请求拿 304（几百字节）。`/api/health` 仍是 `no-store` —— 它是活状态。

改动理由与取舍见 `tools/webapp.py` 里对应注释；`STATIC_CACHE` 的 300 秒可按需调小。
