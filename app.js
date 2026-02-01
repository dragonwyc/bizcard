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
let textBBox = null;
let qrBBox = null;

let pinchTarget = null;     // "qr" | "text"
let longPressTimer = null;
let pressStart = null;      // {x,y}
let movedTooMuch = false;

const LONG_PRESS_MS = 200;
const MOVE_THRESH_PX = 12;  // 超过这个就认为不是长按

// 二维码可拖拽缩放参数（以 canvas 像素为单位）
let qrState = {
  x: 0.75,   // 相对位置（0~1）
  y: 0.70,
  scale: 1.0 // 相对尺寸
};

// ===== 文字可拖拽缩放参数（以 canvas 相对坐标 0~1）=====
let textState = {
  x: 0.08,    // 左上角相对位置
  y: 0.10,
  scale: 1.0  // 文字整体缩放
};

let locked = true;

// 触摸手势
let pointerMode = null; // "drag" | "dragText" | "pinch"
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
  const fullName = ($("name")?.value || "").trim();
  const org      = ($("org")?.value || "").trim();
  const title    = ($("title")?.value || "").trim();

  const telCell  = cleanTel(($("tel")?.value || ""));
  const email    = cleanEmail(($("email")?.value || ""));
  const url      = cleanUrl(($("url")?.value || ""));

  // 👇 读取“可选”的手动输入
  let familyName = ($("familyName")?.value || "").trim();
  let givenName  = ($("givenName")?.value || "").trim();

  /* =====================================================
     关键逻辑：姓名来源决策
     1️⃣ 手动输入优先
     2️⃣ 否则从 fullName 自动拆
  ===================================================== */

  if (!familyName && !givenName) {
    const nameForN = fullName || "";
    const hasChinese = /[\u4E00-\u9FFF]/.test(nameForN);

    if (nameForN) {
      if (hasChinese) {
        // 中文：姓=第一个字，名=剩下
        familyName = nameForN.slice(0, 1);
        givenName  = nameForN.slice(1);
      } else {
        // 英文：姓=最后一个单词，名=前面的
        const parts = nameForN.split(/\s+/).filter(Boolean);
        if (parts.length === 1) {
          familyName = parts[0];
          givenName  = "";
        } else {
          familyName = parts[parts.length - 1];
          givenName  = parts.slice(0, -1).join(" ");
        }
      }
    }
  }

  // 最终兜底，防止 N 为空（避免 iOS 公司模式）
  if (!familyName && !givenName) {
    familyName = fullName || " ";
    givenName  = "";
  }

  const lines = [];
  lines.push("BEGIN:VCARD");
  lines.push("VERSION:2.1");

  // ✅ 明确告诉 iOS：这是“个人联系人”
  lines.push("X-ABShowAs:PERSON");

  // 显示名：完全按你输入的来
  lines.push(
    `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qpEncodeUtf8(fullName || " ")}`
  );

  // 结构化姓名：严格使用 family / given
  lines.push(
    `N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qpEncodeUtf8(familyName)};${qpEncodeUtf8(givenName)};;;`
  );

  if (org)   lines.push(`ORG;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qpEncodeUtf8(org)}`);
  if (title) lines.push(`TITLE;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:${qpEncodeUtf8(title)}`);

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

function cleanTel(s) {
  // 只允许电话常见字符：数字、+、#、*、括号、空格、短横线
  return String(s || "")
    .replace(/[\u00A0\u2000-\u200B\u202F\u3000]/g, " ") // 各种怪空格 → 普通空格
    .replace(/[^\d+\-()#* ]/g, "")                     // 删除非允许字符
    .trim();
}

function cleanEmail(s) {
  return String(s || "")
    .replace(/[\u00A0\u2000-\u200B\u202F\u3000]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function cleanUrl(s) {
  let t = String(s || "").trim();
  t = t.replace(/[\u00A0\u2000-\u200B\u202F\u3000]/g, "");
  // 用户只填了域名时，帮他补 http(s)（iOS 更愿意识别）
  if (t && !/^https?:\/\//i.test(t)) t = "http://" + t;
  return t;
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

  // 基础字号（跟你原来一样的比例）
  const orgSize  = Math.round(ch * 0.055 * textState.scale);
  const nameSize = Math.round(ch * 0.048 * textState.scale);
  const tagSize  = Math.round(ch * 0.028 * textState.scale);

  const x = Math.round(textState.x * cw);
  const y = Math.round(textState.y * ch);

  const gap1 = Math.round(ch * 0.06 * textState.scale);
  const gap2 = Math.round(ch * 0.06 * textState.scale);
  const gap3 = Math.round(ch * 0.045 * textState.scale);

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "white";

  let cursorY = y;

  // 计算 bbox（先测量宽度）
  let maxW = 0;
  let totalH = 0;

  if (org) {
    ctx.font = `800 ${orgSize}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
    maxW = Math.max(maxW, ctx.measureText(org).width);
    totalH += gap1;
  }
  if (name) {
    ctx.font = `700 ${nameSize}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
    maxW = Math.max(maxW, ctx.measureText(name).width);
    totalH += gap2;
  }
  const tag = "BUSINESS CARD";
  ctx.font = `700 ${tagSize}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
  maxW = Math.max(maxW, ctx.measureText(tag).width);
  totalH += gap3;

  // 真正绘制
  if (org) {
    ctx.font = `800 ${orgSize}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
    cursorY += gap1;
    ctx.fillText(org, x, cursorY);
  }
  if (name) {
    ctx.font = `700 ${nameSize}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
    cursorY += gap2;
    ctx.fillText(name, x, cursorY);
  }
  ctx.font = `700 ${tagSize}px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto`;
  cursorY += gap3;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillText(tag, x, cursorY);

  ctx.restore();

  // bbox：给一点 padding，方便点选
  const pad = Math.round(16 * (canvas.width / canvas.getBoundingClientRect().width)); // 约等于16px*dpr
  const left = x - pad;
  const top = y - pad;
  const right = x + maxW + pad;
  const bottom = y + totalH + pad;

  return { left, top, right, bottom };
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
  qrBBox = null;
  textBBox = null;

  // 背景
  if (bgImg) {
    drawCover(bgImg, cw, ch);
  } else {
    // 无背景就给个深色
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, cw, ch);
  }

  textBBox = drawTextOverlay(cw, ch);

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

    // 记录二维码 bbox（用于命中测试）
    qrBBox = { left, top, right: left + s, bottom: top + s };

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

  // 清理上一次长按
  clearLongPress();

  if (ts.length === 1) {
    const t = ts[0];
    lastTouch = t;

    // 默认先按“当前点到谁就拖谁”
    pointerMode = hitBBox(t, textBBox) ? "dragText" : "dragQR";

    // 长按吸附：0.2s 后根据“最近目标”锁定拖拽对象（不用点很准）
    pressStart = { x: t.x, y: t.y };
    movedTooMuch = false;

    longPressTimer = setTimeout(() => {
      if (!lastTouch || movedTooMuch) return;
      const target = pickNearestTarget(lastTouch);
      pointerMode = (target === "text") ? "dragText" : "dragQR";
      // 可选：长按后立即 render 一下（让你感觉“选中”生效）
      render();
    }, LONG_PRESS_MS);

  } else if (ts.length >= 2) {
    // 双指：决定缩放谁（中点落在哪个 bbox / 或最近目标）
    pointerMode = "pinch";
    const a = ts[0], b = ts[1];
    const m = mid(a, b);

    pinchTarget = hitBBox(m, textBBox) ? "text"
                : hitBBox(m, qrBBox)   ? "qr"
                : pickNearestTarget(m);

    pinchStart = {
      d: dist(a, b),
      m,
      target: pinchTarget,
      // 记录起始状态
      qr:  { scale: qrState.scale, x: qrState.x, y: qrState.y },
      text:{ scale: textState.scale, x: textState.x, y: textState.y }
    };
  }
}, { passive:false });

canvas.addEventListener("touchmove", (ev) => {
  if (locked) return;
  ev.preventDefault();

  const ts = getTouches(ev);
  const cw = canvas.width, ch = canvas.height;

  // 判断是否移动过多（会取消长按）
  if (ts.length === 1 && pressStart && lastTouch) {
    const t = ts[0];
    const dx0 = t.x - pressStart.x;
    const dy0 = t.y - pressStart.y;
    if (Math.hypot(dx0, dy0) > MOVE_THRESH_PX) movedTooMuch = true;
    if (movedTooMuch) clearLongPress();
  } else {
    clearLongPress();
  }

  // 单指拖动
  if ((pointerMode === "dragQR" || pointerMode === "dragText") && ts.length === 1 && lastTouch) {
    const t = ts[0];
    const dx = t.x - lastTouch.x;
    const dy = t.y - lastTouch.y;

    if (pointerMode === "dragQR") {
      qrState.x = clamp01(qrState.x + dx / cw);
      qrState.y = clamp01(qrState.y + dy / ch);
    } else {
      textState.x = clamp01(textState.x + dx / cw);
      textState.y = clamp01(textState.y + dy / ch);
    }

    lastTouch = t;
    render();
    return;
  }

  // 双指缩放 + 中点移动（文字/二维码都支持）
  if (pointerMode === "pinch" && ts.length >= 2 && pinchStart) {
    const a = ts[0], b = ts[1];
    const d = dist(a, b);
    const m = mid(a, b);

    const scaleFactor = d / pinchStart.d;
    const dx = m.x - pinchStart.m.x;
    const dy = m.y - pinchStart.m.y;

    if (pinchStart.target === "qr") {
      qrState.scale = clamp(pinchStart.qr.scale * scaleFactor, 0.5, 2.5);
      qrState.x = clamp01(pinchStart.qr.x + dx / cw);
      qrState.y = clamp01(pinchStart.qr.y + dy / ch);
    } else {
      textState.scale = clamp(pinchStart.text.scale * scaleFactor, 0.6, 3.0);
      textState.x = clamp01(pinchStart.text.x + dx / cw);
      textState.y = clamp01(pinchStart.text.y + dy / ch);
    }

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
    pinchTarget = null;
    clearLongPress();
  }
});

function clamp01(v){ return Math.max(0, Math.min(1, v)); }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }
function hitBBox(p, box) {
  if (!box) return false;
  return p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom;
}

function bboxCenter(box) {
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
}

function dist2(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx*dx + dy*dy;
}

function pickNearestTarget(p) {
  // 优先：如果点进了某个 bbox，就直接选它
  if (hitBBox(p, textBBox)) return "text";
  if (hitBBox(p, qrBBox)) return "qr";

  // 否则：选离中心更近的那个（实现“吸附选中”）
  let best = "qr";
  let bestD = Infinity;

  if (qrBBox) {
    bestD = dist2(p, bboxCenter(qrBBox));
  }
  if (textBBox) {
    const d = dist2(p, bboxCenter(textBBox));
    if (d < bestD) {
      bestD = d;
      best = "text";
    }
  }
  return best;
}

function clearLongPress() {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
  pressStart = null;
  movedTooMuch = false;
}

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

// ===== 编辑面板 折叠 / 展开（更稳：等 DOM 就绪再绑定）=====
window.addEventListener("DOMContentLoaded", () => {
  const panel = document.getElementById("panel");
  const togglePanelBtn = document.getElementById("togglePanel");

  if (!panel || !togglePanelBtn) return;

  // 页面首次进入：默认折叠（预览优先）
  panel.classList.add("collapsed");

  togglePanelBtn.addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    resizeCanvas();
    setTimeout(resizeCanvas, 200);
  });
});

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
