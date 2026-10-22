// 单独验那两处「JS 运行时才生成」的 label —— 静态 DOM 里看不到它们，
// 所以静态自查覆盖不到。做法：让页面真的跑起来，切到简单模式、加一颗行星，
// 再看生成出来的卡片里 label 的 for 和 input 的 id 是不是真的对上了。
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, 'starpivot', 'viewer', 'universe.html'), 'utf8');

// 画布桩：jsdom 没有 canvas 实现，给一个"什么都接得住"的对象，
// 让页面脚本能跑完，同时不去假装自己量到了什么。
const mkStub = () => new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : mkStub()),
  set: () => true,
  apply: () => mkStub(),
});

const vc = new VirtualConsole();
const noise = [];
vc.on('jsdomError', e => noise.push(e.message));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:8765/',
  virtualConsole: vc,
  beforeParse(w) {
    w.fetch = () => Promise.reject(new Error('stub: 这台机器不联网'));
    w.HTMLCanvasElement.prototype.getContext = () => mkStub();
  },
});
const w = dom.window, d = w.document;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const $ = s => d.querySelector(s);
const fire = (el, type) => el && el.dispatchEvent(new w.Event(type, { bubbles: true }));

(async () => {
  await sleep(400);                      // 等内联脚本把初始状态建起来
  let n = 0, fail = 0;
  const bad = m => { fail++; console.log('[FAIL] ' + m); };
  const okm = m => console.log('  ok  ' + m);

  fire($('#mode_simple'), 'click');      // 切到普通人模式（renderSimpleBodies 走这条路）
  await sleep(100);
  fire($('#addbody'), 'click');          // 加一颗行星 → 卡片被渲染出来
  await sleep(200);

  const box = $('#simplebodies');
  n++;
  if (!box) { bad('#simplebodies 不存在'); }
  else {
    const labels = [...box.querySelectorAll('label')];
    const inputs = [...box.querySelectorAll('input')];
    console.log(`  卡片里：label ${labels.length} 个 / input ${inputs.length} 个`);

    n++;
    if (labels.length === 0) bad('加了行星之后卡片里一个 label 都没有 —— 渲染可能没跑起来');
    else {
      for (const l of labels) {
        n++;
        const id = l.htmlFor;
        if (!id) { bad(`label「${l.textContent.trim().slice(0,16)}」没有 for`); continue; }
        const t = d.getElementById(id);
        if (!t) { bad(`label for="${id}" 找不到这个 id`); continue; }
        n++;
        if (t.tagName !== 'INPUT') bad(`for="${id}" 指向 <${t.tagName.toLowerCase()}>，不是 input`);
        // 关键：for 指到的那个 input，必须就是同一张卡片里那颗行星的旋钮
        n++;
        if (!l.parentElement.contains(t)) bad(`for="${id}" 指到了卡片外面的控件`);
      }
      // 反向：卡片里的每个 input 都得被某个 label 指着（不能只是"看起来有字"）
      for (const inp of inputs) {
        n++;
        const l = d.querySelector(`label[for="${inp.id}"]`);
        if (!l) bad(`input#${inp.id || '(无 id)'} 没有任何 label 指向它`);
      }
      // id 必须在多颗行星之间互不相同，否则第二次加星就会撞车
      const ids = inputs.map(i => i.id);
      n++;
      if (new Set(ids).size !== ids.length) bad('生成的 id 有重复：' + ids.join(','));
      else okm('input id 互不重复：' + ids.join(', '));

      fire($('#addbody'), 'click');      // 再加一颗，确认 id 不会撞
      await sleep(150);
      const ids2 = [...$('#simplebodies').querySelectorAll('input')].map(i => i.id);
      n++;
      if (new Set(ids2).size !== ids2.length) bad('加到两颗之后 id 撞了：' + ids2.join(','));
      else okm('两颗行星时 id 仍不重复：' + ids2.join(', '));
    }
  }

  console.log(`\n动态部分自查 ${n} 条，fail=${fail}`);
  if (noise.length) console.log('（页面脚本报了 ' + noise.length + ' 条 jsdom 噪音，未计入；前两条：'
    + noise.slice(0, 2).map(s => s.split('\n')[0]).join(' | ') + '）');
  process.exit(fail ? 1 : 0);
})();
