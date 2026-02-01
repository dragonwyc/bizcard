// ===== qrcodejs 1.0.0 中文 UTF-8 补丁（必须在任何 new QRCode 之前执行）=====
(function () {
  if (!window.QRCode) return;

  // 用 TextEncoder 把字符串变成 UTF-8 bytes（最稳）
  if (window.TextEncoder) {
    QRCode.stringToBytes = function (s) {
      return Array.from(new TextEncoder().encode(String(s)));
    };
    return;
  }

  // 兜底：手写 UTF-8 编码（兼容极旧浏览器）
  QRCode.stringToBytes = function (s) {
    s = String(s);
    var bytes = [];
    for (var i = 0; i < s.length; i++) {
      var code = s.charCodeAt(i);

      // surrogate pair (emoji etc.)
      if (0xD800 <= code && code <= 0xDBFF && i + 1 < s.length) {
        var next = s.charCodeAt(i + 1);
        if (0xDC00 <= next && next <= 0xDFFF) {
          code = 0x10000 + ((code - 0xD800) << 10) + (next - 0xDC00);
          i++;
        }
      }

      if (code <= 0x7F) {
        bytes.push(code);
      } else if (code <= 0x7FF) {
        bytes.push(0xC0 | (code >> 6));
        bytes.push(0x80 | (code & 0x3F));
      } else if (code <= 0xFFFF) {
        bytes.push(0xE0 | (code >> 12));
        bytes.push(0x80 | ((code >> 6) & 0x3F));
        bytes.push(0x80 | (code & 0x3F));
      } else {
        bytes.push(0xF0 | (code >> 18));
        bytes.push(0x80 | ((code >> 12) & 0x3F));
        bytes.push(0x80 | ((code >> 6) & 0x3F));
        bytes.push(0x80 | (code & 0x3F));
      }
    }
    return bytes;
  };
})();

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

function qpEncodeUtf8(str) {
  const bytes = new TextEncoder().encode(String(str ?? ""));
  let out = "";
  for (const b of bytes) {
    // 可见 ASCII（不含 '='）和空格原样输出
    if ((b >= 0x21 && b <= 0x7E && b !== 0x3D) || b === 0x20) {
      out += String.fromCharCode(b);
    } else {
      out += "=" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

function foldVCardLine(line, limit = 70) {
  if (line.length <= limit) return line;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i + limit);
    i += limit;
    if (i < line.length) out += chunk + "=\r\n ";
    else out += chunk;
  }
  return out;
}

function buildVCard() {
  const fullName = ($("name")?.value || "").trim();      // 张小泉
  const org      = ($("org")?.value || "").trim();       // 钢铁平台
  const title    = ($("title")?.value || "").trim();     // 董事长

  const telCell  = ($("tel")?.value || "").trim();
  const email    = ($("email")?.value || "").trim();
  const url      = ($("url")?.value || "").trim();

  const familyName = ($("familyName")?.value || "").trim(); // Zhang / 张
  const givenName  = ($("givenName")?.value || "").trim();  // San / 小泉

  const lines = [];
  lines.push("BEGIN:VCARD");
  lines.push("VERSION:2.1");

  // 1️⃣ 显示名：只给一个“最终显示”的中文
  lines.push(
    foldVCardLine(
      `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qpEncodeUtf8(fullName)}`
    )
  );

  // 2️⃣ 结构化姓名：只用于系统索引（不要混合中英）
  // 如果你主要用中文，就把中文放这里
  lines.push(
    foldVCardLine(
      `N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qpEncodeUtf8(familyName)};${qpEncodeUtf8(givenName)};;;`
    )
  );

  if (org) {
    // vCard 2.1：ORG 推荐 company;department 形式（第二段可以为空）
    const orgQP = `${qpEncodeUtf8(org)};`;
  
    // 1) 标准 ORG + WORK 类型（iOS 更容易接收）
    lines.push(
      foldVCardLine(
        `ORG;WORK;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${orgQP}`
      )
    );
  
    // 2) iOS 兜底扩展字段（AddressBook 兼容）
    lines.push(
      foldVCardLine(
        `X-ABORG;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qpEncodeUtf8(org)}`
      )
    );
  }

  if (title) {
    lines.push(
      foldVCardLine(
        `TITLE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qpEncodeUtf8(title)}`
      )
    );
  }

  // 4️⃣ 联系方式（ASCII，不需要 QP）
  if (telCell) lines.push(`TEL;CELL:${telCell}`);
  if (email)   lines.push(`EMAIL:${email}`);
  if (url)     lines.push(`URL:${url}`);

  lines.push("END:VCARD");
  return lines.join("\r\n");
}
function escapeVC(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}


// 用 qrcodejs 生成二维码，并返回一个 Image（与你现有贴 logo 的流程兼容）
// --- 生成二维码图（qrcodejs 1.0.0，支持中文 vCard）---
async function generateQRImage(text) {
  if (!window.QRCode) {
    alert("二维码库未加载：window.QRCode 不存在。");
    throw new Error("QRCode (qrcodejs) not loaded");
  }

  const tmp = document.createElement("div");
  tmp.style.position = "fixed";
  tmp.style.left = "-99999px";
  tmp.style.top = "-99999px";
  document.body.appendChild(tmp);
  tmp.innerHTML = "";

  // 注意：这里直接传 text（补丁会确保 UTF-8 编码）
  new QRCode(tmp, {
    text,
    width: 768,
    height: 768,
    correctLevel: QRCode.CorrectLevel.H,
  });

  await new Promise((r) => requestAnimationFrame(r));

  const c = tmp.querySelector("canvas");
  if (!c) {
    document.body.removeChild(tmp);
    throw new Error("qrcodejs did not render a canvas");
  }

  const dataUrl = c.toDataURL("image/png");
  document.body.removeChild(tmp);

  const img = new Image();
  img.src = dataUrl;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
  });
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

  const pad = Math.round(Math.min(cw, ch) * 0.05);
  const top = pad;

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 10;

  // 公司（更大）
  if (org) {
    ctx.font = `800 ${Math.round(ch * 0.055)}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
    ctx.fillStyle = "white";
    ctx.fillText(org, pad, top + Math.round(ch * 0.06));
  }

  // 姓名
  if (name) {
    ctx.font = `700 ${Math.round(ch * 0.048)}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
    ctx.fillStyle = "white";
    ctx.fillText(name, pad, top + Math.round(ch * 0.12));
  }

  // BUSINESS CARD（小字，作为标识）
  ctx.font = `700 ${Math.round(ch * 0.028)}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText("BUSINESS CARD", pad, top + Math.round(ch * 0.165));

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
    const s = Math.floor(base * qrState.scale);

    const x = Math.floor(qrState.x * cw);
    const y = Math.floor(qrState.y * ch);

    // 让 x,y 表示中心点
    const left = Math.floor(x - s / 2);
    const top  = Math.floor(y - s / 2);

    // 给二维码加个白底圆角（更像名片）
    const r = Math.floor(s * 0.08);
    roundRect(left - 14, top - 14, s + 28, s + 28, r + 10, "#ffffff");
    ctx.drawImage(qrImg, left, top, s, s);

    // ===== 叠加 Logo 到二维码中心（如果用户上传了 logo）=====
    if (logoImg) {
      const logoRatio = 0.14; // logo 占二维码宽度比例，可改 0.18~0.26
      const logoSize = Math.floor(s * logoRatio);
    
      const lx = Math.floor(left + (s - logoSize) / 2);
      const ly = Math.floor(top + (s - logoSize) / 2);
    
      // 先画白底（遮住二维码，提升可扫性）
      roundRect(lx, ly, logoSize, logoSize, Math.floor(logoSize * 0.18), "white");
    
      // 再画 logo
      ctx.drawImage(logoImg, lx, ly, logoSize, logoSize);
    }
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

// ===== 编辑面板 折叠 / 展开 =====
const panel = document.getElementById("panel");
const togglePanelBtn = document.getElementById("togglePanel");

if (panel && togglePanelBtn) {
  togglePanelBtn.addEventListener("click", () => {
    panel.classList.toggle("collapsed");

    // 折叠 / 展开后，画布高度会变化
    resizeCanvas();
    setTimeout(resizeCanvas, 200);
  });

  // 页面首次进入：默认折叠（预览优先）
  panel.classList.add("collapsed");
}

// ===== 输入变化自动刷新（防抖）=====
let regenTimer = null;
["name","familyName","givenName","org","title","tel","email","url"].forEach(id=>{
  const el = document.getElementById(id);
  el?.addEventListener("input", ()=>{
    clearTimeout(regenTimer);
    regenTimer = setTimeout(regenerate, 250);
  });
});
// ===== 画布初始化 & 适配 iOS Safari =====
window.addEventListener("resize", resizeCanvas);

// 立即算一次
resizeCanvas();
regenerate();

// iOS Safari 地址栏/工具栏会在 0~300ms 内变化
// 延迟再算一次，防止画布高度偏小
setTimeout(resizeCanvas, 300);
