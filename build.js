// 构建脚本：从 extension/core.js 组装 pokebonk-afk.user.js
// 用法：node build.js
// 保证油猴内嵌核心与 extension/core.js 字节级一致（注释头只出现一次）。
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const core = fs.readFileSync(path.join(__dirname, 'extension/core.js'), 'utf8');
const userjsPath = path.join(__dirname, 'pokebonk-afk.user.js');
const old = fs.readFileSync(userjsPath, 'utf8');

// header = 油猴元数据 + IIFE 开头（固定到第一个注释头之前，绝不累积 core 的内容）
const headerEnd = old.indexOf('/* ============================================================');
if (headerEnd < 0) throw new Error('old userscript: comment header not found');
const header = old.slice(0, headerEnd);

// footer = 注入保障段到文件尾（从旧文件尾部提取）
const footerIdx = old.lastIndexOf('/* ---------------- 注入保障');
const footer = old.slice(footerIdx - 2);

const version = (old.match(/@version\s+(\S+)/) || [])[1];
if (!version) throw new Error('old userscript: @version not found');

const full = header + core + '\n' + footer;
fs.writeFileSync(userjsPath, full);

// 校验：内嵌核心必须与 core.js 完全一致
const check = full.slice(full.indexOf('/* ============================================================'), full.lastIndexOf('/* ---------------- 注入保障') - 2).replace(/\s+$/, '');
const ok = check === core.trim();
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
console.log('版本:', version, '| 字节:', full.length);
console.log('内嵌核心 == extension/core.js:', ok ? '✅ 字节级一致' : '❌ 不一致');
console.log('  embedded:', hash(check), '| core:', hash(core.trim()));
if (!ok) { process.exitCode = 1; }
