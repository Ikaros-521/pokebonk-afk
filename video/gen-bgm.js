// 程序化 chiptune BGM 生成器：NES 风格，150BPM，Am-F-C-G 循环
const fs = require('fs');
const SR = 44100, BPM = 150, STEP = 60 / BPM / 4; // 16分音符时长(s)
const f = (m) => 440 * Math.pow(2, (m - 69) / 12);
const LEAD_DUTY = 0.25;
// 和弦琶音 (midi)
const CHORDS = [
  { arp: [69, 72, 76, 81], bass: 45 },  // Am: A4 C5 E5 A5 / A2
  { arp: [65, 69, 72, 77], bass: 41 },  // F:  F4 A4 C5 F5 / F2
  { arp: [60, 64, 67, 72], bass: 48 },  // C:  C4 E4 G4 C5 / C3
  { arp: [67, 71, 74, 79], bass: 43 },  // G:  G4 B4 D5 G5 / G2
];
const ARP_PAT = [0, 1, 2, 3, 2, 3, 2, 1, 0, 1, 2, 3, 2, 3, 2, 1];
// 顶部旋律（长音，pentatonic），每小节8个8分位：null=休止
const TOP = [
  [81, null, 79, null, 76, null, 72, null],   // Am: E5 . C5 . E4? -> A5 C5 G5 E5 下行
  [77, null, 76, null, 72, null, 69, null],   // F:  F5 . E5 . C5 . A4
  [79, null, 76, null, 72, null, 74, null],   // C:  G5 . E5 . C5 . D5
  [74, null, 72, null, 69, null, 67, null],   // G:  D5 . C5 . A4 . G4
];
const BARS = 4, STEPS_PER_BAR = 16;
function square(t, freq, duty) { const p = (t * freq) % 1; return p < duty ? 1 : -1; }
function tri(t, freq) { const p = (t * freq) % 1; return p < 0.5 ? 4 * p - 1 : 3 - 4 * p; }
let noiseState = 12345;
function noise() { noiseState = (noiseState * 1103515245 + 12345) & 0x7fffffff; return (noiseState / 0x7fffffff) * 2 - 1; }
function envNote(t, dur, a = 0.005, d = 0.06, s = 0.6, r = 0.03) {
  if (t < a) return t / a;
  if (t < dur) { const x = t - a; if (x < d) return 1 - (1 - s) * (x / d); return s; }
  const x = t - dur; if (x < r) return s * (1 - x / r); return 0;
}
const totalSteps = BARS * STEPS_PER_BAR * 8 + 16; // 8 循环 + 尾音
const totalSec = totalSteps * STEP + 1.2;
const N = Math.ceil(totalSec * SR);
const L = new Float64Array(N), R = new Float64Array(N);
for (let st = 0; st < totalSteps; st++) {
  const bar = Math.floor(st / STEPS_PER_BAR) % BARS;
  const sInBar = st % STEPS_PER_BAR;
  const t0 = st * STEP;
  const ch = CHORDS[bar];
  // lead arp: 每步一个音，短促
  {
    const midi = ch.arp[ARP_PAT[sInBar]];
    const dur = STEP * 0.9;
    const n0 = Math.floor(t0 * SR), n1 = Math.min(N, Math.floor((t0 + dur + 0.05) * SR));
    for (let i = n0; i < n1; i++) {
      const t = i / SR - t0; const e = envNote(t, dur, 0.002, 0.02, 0.5, 0.02);
      const v = square(t, f(midi), LEAD_DUTY) * e * 0.16;
      L[i] += v; R[i] += v;
    }
  }
  // top melody: 8分音符（每2步）
  if (sInBar % 2 === 0) {
    const midi = TOP[bar][sInBar / 2];
    if (midi != null) {
      const dur = STEP * 2 * 0.95;
      const n0 = Math.floor(t0 * SR), n1 = Math.min(N, Math.floor((t0 + dur + 0.08) * SR));
      for (let i = n0; i < n1; i++) {
        const t = i / SR - t0; const e = envNote(t, dur, 0.004, 0.05, 0.55, 0.04);
        const v = square(t, f(midi), 0.5) * e * 0.13;
        L[i] += v * 0.8; R[i] += v * 1.1; // 旋律稍偏右
      }
    }
  }
  // bass: 8分，根音/八度/五度
  if (sInBar % 2 === 0) {
    const pat = [0, 12, 7, 12];
    const midi = ch.bass + pat[(sInBar / 2) % 4];
    const dur = STEP * 1.8;
    const n0 = Math.floor(t0 * SR), n1 = Math.min(N, Math.floor((t0 + dur + 0.05) * SR));
    for (let i = n0; i < n1; i++) {
      const t = i / SR - t0; const e = envNote(t, dur, 0.003, 0.04, 0.7, 0.03);
      const v = tri(t, f(midi)) * e * 0.3;
      L[i] += v; R[i] += v;
    }
  }
  // drums
  if (sInBar % 8 === 0) { // kick
    const n0 = Math.floor(t0 * SR), n1 = Math.min(N, n0 + Math.floor(0.12 * SR));
    for (let i = n0; i < n1; i++) { const t = i / SR - t0; const fr = 150 * Math.exp(-t * 28) + 40; L[i] += Math.sin(2 * Math.PI * fr * t) * Math.exp(-t * 30) * 0.5; R[i] += 0; }
    for (let i = n0; i < n1; i++) { const t = i / SR - t0; const fr = 150 * Math.exp(-t * 28) + 40; R[i] += Math.sin(2 * Math.PI * fr * t) * Math.exp(-t * 30) * 0.5; }
  }
  if (sInBar % 8 === 4) { // snare
    const n0 = Math.floor(t0 * SR), n1 = Math.min(N, n0 + Math.floor(0.1 * SR));
    for (let i = n0; i < n1; i++) { const t = i / SR - t0; const v = noise() * Math.exp(-t * 40) * 0.22 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 50) * 0.12; L[i] += v; R[i] += v; }
  }
  { // hats: 每步，弱拍重音
    const dur = sInBar % 4 === 2 ? 0.05 : 0.025;
    const amp = sInBar % 4 === 2 ? 0.09 : 0.045;
    const n0 = Math.floor(t0 * SR), n1 = Math.min(N, n0 + Math.floor(dur * SR));
    for (let i = n0; i < n1; i++) { const t = i / SR - t0; const v = noise() * Math.exp(-t * 90) * amp; L[i] += v; R[i] += v; }
  }
}
// 结尾：最后一拍长音 + 整体淡出
{
  const tEnd = totalSteps * STEP;
  const n0 = Math.floor(tEnd * SR), n1 = Math.min(N, Math.floor((tEnd + 1.0) * SR));
  for (let i = n0; i < n1; i++) { const t = i / SR - tEnd; const v = square(t, f(81), 0.5) * Math.exp(-t * 3.5) * 0.18; L[i] += v; R[i] += v; }
}
const fadeN = Math.floor(1.5 * SR);
for (let i = 0; i < fadeN; i++) { const g = 1 - i / fadeN; const j = N - 1 - i; L[j] *= g; R[j] *= g; }
// 峰值归一化到 0.85
let peak = 0; for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
const g = 0.85 / peak;
// 写 16-bit PCM WAV
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * g * 32767))), 44 + i * 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * g * 32767))), 44 + i * 4 + 2);
}
fs.writeFileSync('assets/audio/bgm.wav', buf);
console.log('bgm.wav written:', (buf.length / 1024 / 1024).toFixed(1), 'MB, duration:', totalSec.toFixed(1), 's');
