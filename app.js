// --- PWA: 注册 Service Worker ---
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try { await navigator.serviceWorker.register("./sw.js"); } catch {}
  });
}

const $ = (id) => document.getElementById(id);
const canvas = $("c");
const ctx = canvas.getContext("2d");

let bgImg = null;
let logoImg = null;
let qrImg = null; // 用 Image 存放生成后的二维码图

// 二维码可拖拽缩放参数（以 canvas 像素为单位）
let qrState = {
  x: 0.75,   // 相对位置（0~1）
  y: 0.70,
  scale: 1.0 // 相对尺寸
};

let locked = true;

// 触摸手势
let pointerMode = null; // "drag" | "pinch"
let lastTouch = null;
let pinchStart = null;

// --- 工具：读文件为 Image ---
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

// --- 生成 vCard 文本 ---
function buildVCard() {
  const name = $("name").value.trim();
  const org  = $("org").value.trim();
  const title= $("title").value.trim();
  const tel  = $("tel").value.trim();
  const email= $("email").value.trim();
  const url  = $("url").value.trim();

  // 最小可用 vCard 3.0
  // N: 姓;名;;; 这里简单拆分：把整串塞到名字段
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVC(name)}`,
    `N:;${escapeVC(name)};;;`
  ];
  if (org)   lines.push(`ORG:${escapeVC(org)}`);
  if (title) lines.push(`TITLE:${escapeVC(title)}`);
  if (tel)   lines.push(`TEL;TYPE=CELL:${escapeVC(tel)}`);
  if (email) lines.push(`EMAIL;TYPE=INTERNET:${escapeVC(email)}`);
  if (url)   lines.push(`URL:${escapeVC(url)}`);
  lines.push("END:VCARD");
  return lines.join("\n");
}
function escapeVC(s) {
  return s.replace(/\\/g,"\\\\").replace(/\n/g,"\\n").replace(/;/g,"\\;").replace(/,/g,"\\,");
}

// --- 生成二维码图（带 logo 挖空叠加） ---
async function generateQRImage(vcardText) {
  // 先生成纯二维码到离屏 canvas
  const size = 1024; // 输出清晰度
  const off = document.createElement("canvas");
  off.width = off.height = size;
  await QRCode.toCanvas(off, vcardText, {
    errorCorrectionLevel: "H",
    margin: 2,
    color: { dark: "#000000", light: "#ffffff" }
  });

  const octx = off.getContext("2d");

  // 叠加 logo（你 Python 的思路：中间挖白再贴）
  if (logoImg) {
    const logoRatio = 0.16; // 安全值
    const logoH = Math.floor(size * logoRatio);
    const logoW = Math.floor(logoH * (375 / 140)); // 保持你原先的宽高比

    const left = Math.floor((size - logoW) / 2);
    const top  = Math.floor((size - logoH) / 2);

    // 挖空
    octx.fillStyle = "#ffffff";
    octx.fillRect(left, top, logoW, logoH);

    // 画 logo（按透明通道）
    octx.drawImage(logoImg, left, top, logoW, logoH);
  }

  // 转成 Image 方便主画布 drawImage
  const img = new Image();
  img.src = off.toDataURL("image/png");
  await img.decode();
  return img;
}

// --- 画背景 cover（全屏裁切）---
function drawCover(img, cw, ch) {
  const iw = img.width, ih = img.height;
  const scale = Math.max(cw / iw, ch / ih);
  const sw = iw * scale, sh = ih * scale;
  const sx = (cw - sw) / 2;
  const sy = (ch - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh);
}

// --- 画文字（公司/姓名）---
function drawTextOverlay(cw, ch) {
  const org = $("org").value.trim();
  const name = $("name").value.trim();

  const pad = Math.round(Math.min(cw, ch) * 0.04);
  const yTop = pad;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 8;

  // 公司
  if (org) {
    ctx.font = `700 ${Math.round(ch * 0.05)}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
    ctx.fillStyle = "white";
    ctx.fillText(org, pad, yTop + Math.round(ch * 0.06));
  }

  // 姓名
  if (name) {
    ctx.font = `600 ${Math.round(ch * 0.045)}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
    ctx.fillStyle = "white";
    const y = yTop + Math.round(ch * 0.12);
    ctx.fillText(name, pad, y);
  }

  ctx.restore();
}

// --- 主渲染 ---
function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  render();
}

function render() {
  const cw = canvas.width, ch = canvas.height;
  ctx.clearRect(0, 0, cw, ch);

  // 背景
  if (bgImg) {
    drawCover(bgImg, cw, ch);
  } else {
    // 无背景就给个深色
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, cw, ch);
  }

  drawTextOverlay(cw, ch);

  // 二维码
  if (qrImg) {
    const base = Math.min(cw, ch) * 0.28; // 基础显示尺寸
    const s = base * qrState.scale;

    const x = Math.floor(qrState.x * cw);
    const y = Math.floor(qrState.y * ch);

    // 让 x,y 表示中心点
    const left = Math.floor(x - s / 2);
    const top  = Math.floor(y - s / 2);

    // 给二维码加个白底圆角（更像名片）
    const r = Math.floor(s * 0.08);
    roundRect(left - 10, top - 10, s + 20, s + 20, r + 8, "rgba(255,255,255,0.92)");
    ctx.drawImage(qrImg, left, top, s, s);
  }
}

function roundRect(x, y, w, h, r, fillStyle) {
  ctx.save();
  ctx.fillStyle = fillStyle;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// --- 生成/刷新 ---
async function regenerate() {
  const vcard = buildVCard();
  qrImg = await generateQRImage(vcard);
  render();
}

// --- 背景/logo 选择 ---
$("bgFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  bgImg = await fileToImage(f);
  render();
});

$("logoFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) { logoImg = null; await regenerate(); return; }
  logoImg = await fileToImage(f);
  await regenerate();
});

$("regen").addEventListener("click", regenerate);

$("lock").addEventListener("click", () => {
  locked = !locked;
  $("lock").textContent = `锁定位置：${locked ? "开" : "关"}`;
});

// --- 手势：拖动+双指缩放（作用于二维码）---
function getTouches(ev) {
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  const touches = [...ev.touches].map(t => ({
    x: (t.clientX - rect.left) * dpr,
    y: (t.clientY - rect.top) * dpr,
    id: t.identifier
  }));
  return touches;
}
function dist(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return Math.hypot(dx,dy); }
function mid(a,b){ return { x:(a.x+b.x)/2, y:(a.y+b.y)/2 }; }

canvas.addEventListener("touchstart", (ev) => {
  if (locked) return;
  ev.preventDefault();
  const ts = getTouches(ev);
  if (ts.length === 1) {
    pointerMode = "drag";
    lastTouch = ts[0];
  } else if (ts.length >= 2) {
    pointerMode = "pinch";
    const a = ts[0], b = ts[1];
    pinchStart = {
      d: dist(a,b),
      m: mid(a,b),
      scale: qrState.scale,
      x: qrState.x,
      y: qrState.y
    };
  }
}, { passive:false });

canvas.addEventListener("touchmove", (ev) => {
  if (locked) return;
  ev.preventDefault();
  const ts = getTouches(ev);
  const cw = canvas.width, ch = canvas.height;

  if (pointerMode === "drag" && ts.length === 1 && lastTouch) {
    const t = ts[0];
    const dx = t.x - lastTouch.x;
    const dy = t.y - lastTouch.y;
    qrState.x = clamp01(qrState.x + dx / cw);
    qrState.y = clamp01(qrState.y + dy / ch);
    lastTouch = t;
    render();
  }

  if (pointerMode === "pinch" && ts.length >= 2 && pinchStart) {
    const a = ts[0], b = ts[1];
    const d = dist(a,b);
    const m = mid(a,b);

    const scaleFactor = d / pinchStart.d;
    qrState.scale = clamp(pinchStart.scale * scaleFactor, 0.5, 2.5);

    // 同时允许用双指中点移动
    const dx = m.x - pinchStart.m.x;
    const dy = m.y - pinchStart.m.y;
    qrState.x = clamp01(pinchStart.x + dx / cw);
    qrState.y = clamp01(pinchStart.y + dy / ch);

    render();
  }
}, { passive:false });

canvas.addEventListener("touchend", (ev) => {
  if (locked) return;
  const ts = getTouches(ev);
  if (ts.length === 0) {
    pointerMode = null;
    lastTouch = null;
    pinchStart = null;
  }
});

function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

// --- 导出图片：优先系统分享，其次下载 ---
$("export").addEventListener("click", async () => {
  // 确保最新渲染
  render();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 0.92));
  if (!blob) return alert("导出失败：浏览器不支持 canvas.toBlob");

  const file = new File([blob], `bizcard_${Date.now()}.png`, { type: "image/png" });

  // Web Share（iOS/安卓支持情况不一）
  // 不能保证 iOS 一定能 share 文件，这是现实情况
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
      await navigator.share({ files: [file], title: "名片图片", text: "生成的名片二维码图片" });
      return;
    }
  } catch {}

  // 退化：下载
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  alert("已下载图片。iPhone 若未保存到相册，可在文件/分享里选择“存储图像”。");
});

// 初始渲染
window.addEventListener("resize", resizeCanvas);
resizeCanvas();
regenerate();
