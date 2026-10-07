#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""keep-alive 污染探针：未知路由吞掉（而不是消费掉）请求体时，
残留字节会被**下一个请求**当成请求行解析 → 后续那条无关的真请求收到 4xx/5xx 与一张 HTML 错误页。

这条判据的价值在于：**症状出现在一条完全没有问题的请求上**。
真正做错的（未知路由没读 body）与挨罚的（后面那条 nbody）是**两条不同的请求**，
所以任何"逐请求看响应"的观察方式都抓不到它 —— 必须在**同一条 TCP 连接上**连发两条。

⚠ 路径必须用一个**真不存在**的端点。实测踩过：初版用 `/api/lagrange` 当"未知路由"，
而它这周已经被实现成真端点了（`src/lagrange.cpp`）→ 回 200，判据前提失效。
所以这里用一个绝不可能被实现的路径，并在断言里写明"它必须是 4xx"。

⚠ 加固（实测踩过）：在**有缺陷**的网关上，污染会让第二条请求写到一半被中止，
抛 `ConnectionAbortedError`。第一版没接住异常 → 进程带 traceback 崩掉、**结果文件根本没写**。
那会让"红"变成"没有产物"，比红本身更糟（后面的人只会看到一份陈旧的结果文件）。
所以每个回合都要接住异常、记成 FAIL，并且**无论如何都落盘**。

退出码：0 全过 / 1 有失败 / 2 起不了服务（跳过，不算失败）。
"""
import json
import os
import sys
import http.client

HOST = os.environ.get("STARPIVOT_HOST", "127.0.0.1")
PORT = int(os.environ.get("STARPIVOT_PORT", "8765"))
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_probe_keepalive.txt")

# 绝不能是一个"以后可能会被实现"的名字 —— 判据前提是它一定 404。
UNKNOWN_PATH = "/api/__probe_keepalive_no_such_endpoint__"
UNKNOWN_BODY = {"primary": "Sun", "secondary": "Earth", "a_au": 0.387099}
NBODY = {"scenario": "solar", "solar": "sun", "years": 1, "samples": 100}

lines = []
n_pass = 0
n_fail = 0


def ok(cond, label, extra=""):
    global n_pass, n_fail
    if cond:
        n_pass += 1
        lines.append("  PASS  " + label + (("   " + extra) if extra else ""))
    else:
        n_fail += 1
        lines.append("  FAIL  " + label + (("   " + extra) if extra else ""))
    return cond


def say(s=""):
    lines.append(s)


def write_out():
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
        f.write("\n[keepalive] n=%d fail=%d\n" % (n_pass + n_fail, n_fail))


def post(conn, path, obj):
    b = json.dumps(obj).encode()
    conn.request("POST", path, body=b,
                 headers={"Content-Type": "application/json", "Content-Length": str(len(b))})
    r = conn.getresponse()
    return r.status, r.read()


def is_html(raw):
    return raw[:200].decode("utf-8", "replace").lstrip().startswith("<")


def body_count(raw):
    try:
        d = json.loads(raw.decode("utf-8"))
        return (d.get("status"), len(d.get("bodies") or []))
    except Exception:  # noqa: BLE001
        return (None, -1)


def check_pair(label, first_path, first_obj):
    """同一条连接：先发一条（未知路由 / 大 body），再发一条真 nbody。

    **任何异常都记成 FAIL**（有缺陷的网关会把连接写到一半就中止）。
    返回第一条的状态码；出错返回 None。
    """
    c = None
    try:
        c = http.client.HTTPConnection(HOST, PORT, timeout=90)
        s1, _ = post(c, first_path, first_obj)
        s2, raw2 = post(c, "/api/nbody", NBODY)
    except Exception as e:  # noqa: BLE001
        ok(False, "%s：同一连接上连发两条时连接被中止（残留字节把连接弄坏了）" % label,
           "%s: %s" % (type(e).__name__, e))
        return None
    finally:
        if c is not None:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass
    ok(s2 == 200, "%s：后一条真请求仍是 200（没被残留字节顶掉）" % label, "HTTP=%d" % s2)
    ok(not is_html(raw2), "%s：后一条回的是 JSON，不是 HTML 错误页" % label,
       raw2[:110].decode("utf-8", "replace").replace("\n", " "))
    st, nb = body_count(raw2)
    ok(st == "ok" and nb > 0, "%s：后一条真的是内核回执（有天体）" % label,
       "status=%s bodies=%d" % (st, nb))
    return s1


def main():
    say("== keep-alive 污染探针（同一连接连发两条）==")
    say("目标 %s:%d  未知路由样本 = %s" % (HOST, PORT, UNKNOWN_PATH))

    try:
        hc = http.client.HTTPConnection(HOST, PORT, timeout=10)
        hc.request("GET", "/api/health")
        hh = hc.getresponse()
        health = hh.status
        hh.read()
        hc.close()
    except Exception as e:  # noqa: BLE001
        say("  [SKIP] %s:%d 上没有服务（%s）" % (HOST, PORT, e))
        return 2

    ok(health == 200, "前置：/api/health 可达", "HTTP=%d" % health)

    # ---- 回合 1：未知路由（小 body）→ 真请求 ----
    s1 = check_pair("回合1 未知路由", UNKNOWN_PATH, UNKNOWN_BODY)
    if s1 is not None:
        ok(400 <= s1 < 500,
           "回合1：未知路由本身被明确拒绝（4xx），不是 200 假成功", "HTTP=%d" % s1)
        ok(s1 != 501,
           "回合1：它自己也不是 501（501 = 连它都被更早的残渣污染了）", "HTTP=%d" % s1)
    else:
        ok(False, "回合1：没拿到未知路由的状态码（连接已坏）")

    # ---- 回合 2：换一条新连接重做，确认不是"碰巧干净" ----
    check_pair("回合2 换新连接", UNKNOWN_PATH, UNKNOWN_BODY)

    # ---- 回合 3：大 body（>1MB，走 _drain_body「不解析但仍消费干净」的分支） ----
    check_pair("回合3 2MB body", UNKNOWN_PATH, {"pad": "x" * (2 * 1024 * 1024)})

    # ---- 回合 4：负样本对照 —— 两条都是**已存在**端点，也必须全 200 ----
    # 判据判的是"连接洁净度"，不是"端点存不存在"；这一条防的是"判据其实在测 404 有没有"。
    c = None
    try:
        c = http.client.HTTPConnection(HOST, PORT, timeout=90)
        a1, _ = post(c, "/api/nbody", NBODY)
        a2, raw_a2 = post(c, "/api/nbody", NBODY)
        ok(a1 == 200 and a2 == 200 and not is_html(raw_a2),
           "回合4 负样本：两条都是已知端点时全 200（自证判据测的是连接洁净度，不是端点有无）",
           "HTTP=%d,%d" % (a1, a2))
    except Exception as e:  # noqa: BLE001
        ok(False, "回合4 负样本：两条已知端点竟也出错（说明问题不在 404 分支）",
           "%s: %s" % (type(e).__name__, e))
    finally:
        if c is not None:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass

    # ---- 回合 5：会自己读 body 的已知端点（lagrange）→ 真请求 ----
    c = None
    try:
        c = http.client.HTTPConnection(HOST, PORT, timeout=90)
        l1, _ = post(c, "/api/lagrange", UNKNOWN_BODY)
        l2, raw_l2 = post(c, "/api/nbody", NBODY)
        ok(l2 == 200 and not is_html(raw_l2),
           "回合5：会自己读 body 的已知端点（lagrange）之后，真请求照样干净",
           "HTTP=%d,%d" % (l1, l2))
    except Exception as e:  # noqa: BLE001
        ok(False, "回合5：lagrange 之后连接被弄坏", "%s: %s" % (type(e).__name__, e))
    finally:
        if c is not None:
            try:
                c.close()
            except Exception:  # noqa: BLE001
                pass

    return 1 if n_fail else 0


if __name__ == "__main__":
    rc = 2
    try:
        rc = main()
    except Exception as e:  # noqa: BLE001
        say("  FAIL  探针自身异常：%s: %s" % (type(e).__name__, e))
        n_fail += 1
        rc = 1
    finally:
        # 无论如何都落盘 —— 「红」绝不能变成「没有产物」。
        write_out()
        print("\n".join(lines))
    sys.exit(rc)
