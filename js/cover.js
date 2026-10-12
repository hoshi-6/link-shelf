// 表紙まわり:色パレット、サイト画像の自動取得、手持ち画像の切り抜き

// 本のクロス装丁をイメージした 8 色。どれも白文字とのコントラスト比 4.5 以上
export const PALETTE = [
  { name: 'えんじ', value: '#8c2f39' },
  { name: 'れんが', value: '#9a4a1f' },
  { name: 'からし', value: '#7d5f0e' },
  { name: 'もえぎ', value: '#456b32' },
  { name: 'あおみどり', value: '#226468' },
  { name: 'あい', value: '#2d4f86' },
  { name: 'ふじ', value: '#5b3f86' },
  { name: 'すみ', value: '#45413c' },
];

export function colorOf(index) {
  return (PALETTE[index] || PALETTE[0]).value;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export function normalizeUrl(input) {
  const s = input.trim();
  if (!s) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s;
}

// microlink でタイトルとサムネイル(OGP 画像)を取得する。失敗したら {}
export async function fetchMeta(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch('https://api.microlink.io/?url=' + encodeURIComponent(url), { signal: ctrl.signal });
    if (!res.ok) return {};
    const json = await res.json();
    if (json.status !== 'success' || !json.data) return {};
    return { title: json.data.title || '', image: (json.data.image && json.data.image.url) || '' };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

export function screenshotUrl(url) {
  return 'https://image.thum.io/get/width/400/crop/600/' + url;
}

// ---- 画像の切り抜き(2:3) ----
// frame: 2:3 の枠要素。zoomInput: range 要素(1〜3)。
export function createCropper(frame, zoomInput, file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const src = URL.createObjectURL(file);
    img.onerror = () => { URL.revokeObjectURL(src); reject(new Error('image-load')); };
    img.onload = () => {
      frame.replaceChildren(img);
      img.className = 'crop-img';
      img.draggable = false;
      let W = frame.clientWidth, H = frame.clientHeight;
      const base = () => Math.max(W / img.naturalWidth, H / img.naturalHeight);
      let zoom = 1;
      let s = base();
      let x = (W - img.naturalWidth * s) / 2;
      let y = (H - img.naturalHeight * s) / 2;

      const clamp = () => {
        const w = img.naturalWidth * s, h = img.naturalHeight * s;
        x = Math.min(0, Math.max(W - w, x));
        y = Math.min(0, Math.max(H - h, y));
      };
      const apply = () => {
        clamp();
        img.style.width = img.naturalWidth * s + 'px';
        img.style.transform = `translate(${x}px, ${y}px)`;
      };
      const setZoom = z => {
        // 枠の中心を基準に拡大縮小する
        const cx = (W / 2 - x) / s, cy = (H / 2 - y) / s;
        zoom = z;
        s = base() * zoom;
        x = W / 2 - cx * s;
        y = H / 2 - cy * s;
        apply();
      };

      let drag = null;
      const down = e => { drag = { px: e.clientX, py: e.clientY, x, y }; frame.setPointerCapture(e.pointerId); };
      const move = e => {
        if (!drag) return;
        x = drag.x + e.clientX - drag.px;
        y = drag.y + e.clientY - drag.py;
        apply();
      };
      const up = () => { drag = null; };
      const onZoom = () => setZoom(Number(zoomInput.value));
      frame.addEventListener('pointerdown', down);
      frame.addEventListener('pointermove', move);
      frame.addEventListener('pointerup', up);
      frame.addEventListener('pointercancel', up);
      zoomInput.value = '1';
      zoomInput.addEventListener('input', onZoom);
      apply();

      resolve({
        // ダイアログが開いた後に枠の大きさが変わったときに呼ぶ
        refit() {
          if (!frame.clientWidth) return;
          const fx = (W / 2 - x) / s, fy = (H / 2 - y) / s;
          W = frame.clientWidth; H = frame.clientHeight;
          s = base() * zoom;
          x = W / 2 - fx * s; y = H / 2 - fy * s;
          apply();
        },
        toDataUrl() {
          const OW = 400, OH = 600, r = OW / W;
          const canvas = document.createElement('canvas');
          canvas.width = OW; canvas.height = OH;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, OW, OH);
          ctx.drawImage(img, x * r, y * r, img.naturalWidth * s * r, img.naturalHeight * s * r);
          return canvas.toDataURL('image/jpeg', 0.82);
        },
        destroy() {
          frame.removeEventListener('pointerdown', down);
          frame.removeEventListener('pointermove', move);
          frame.removeEventListener('pointerup', up);
          frame.removeEventListener('pointercancel', up);
          zoomInput.removeEventListener('input', onZoom);
          URL.revokeObjectURL(src);
        },
      });
    };
    img.src = src;
  });
}
