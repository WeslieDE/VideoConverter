'use strict';

const { execFile } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 16 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

function firstLine(stdout) {
  const line = stdout.split('\n')[0].trim().replace(/,$/, '');
  return line.length ? line : null;
}

async function getVideoField(input, field) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', `stream=${field}`,
    '-of', 'csv=p=0',
    input,
  ]);
  return firstLine(out);
}

async function getFormatBitrate(input) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=bit_rate',
    '-of', 'csv=p=0',
    input,
  ]);
  return firstLine(out);
}

async function getDurationSeconds(input) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    input,
  ]);
  const line = firstLine(out);
  return line ? parseFloat(line) : null;
}

async function getAudioField(input, idx, field) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', `a:${idx}`,
    '-show_entries', `stream=${field}`,
    '-of', 'csv=p=0',
    input,
  ]);
  return firstLine(out);
}

async function getSubtitleField(input, idx, field) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', `s:${idx}`,
    '-show_entries', `stream=${field}`,
    '-of', 'csv=p=0',
    input,
  ]);
  return firstLine(out);
}

async function getStreamLanguages(input, selectStreams) {
  const out = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', selectStreams,
    '-show_entries', 'stream_tags=language',
    '-of', 'csv=p=0',
    input,
  ]);
  return out
    .split('\n')
    .map((l) => l.trim().replace(/,$/, ''))
    .filter((l) => l.length > 0 || l === '');
}

// 0-basierter Index innerhalb aller Audiostreams; bevorzugt Deutsch, sonst erste Spur.
async function findGermanAudioIndex(input) {
  let langs;
  try {
    langs = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 'a',
      '-show_entries', 'stream_tags=language',
      '-of', 'csv=p=0',
      input,
    ]);
  } catch {
    return -1;
  }
  const lines = langs.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
  if (lines.length === 0) return -1;
  const idx = lines.findIndex((l) => /^(ger|deu|de)\s*$/i.test(l.trim().replace(/,$/, '')));
  return idx >= 0 ? idx : 0;
}

// 0-basierter Index innerhalb aller Untertitelstreams; bevorzugt Deutsch, dann Englisch, sonst -1.
async function findSubtitleIndex(input) {
  let langs;
  try {
    langs = await run('ffprobe', [
      '-v', 'error',
      '-select_streams', 's',
      '-show_entries', 'stream_tags=language',
      '-of', 'csv=p=0',
      input,
    ]);
  } catch {
    return -1;
  }
  const lines = langs.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
  if (lines.length === 0) return -1;
  const de = lines.findIndex((l) => /^(ger|deu|de)\s*$/i.test(l.trim().replace(/,$/, '')));
  if (de >= 0) return de;
  const en = lines.findIndex((l) => /^(eng|en)\s*$/i.test(l.trim().replace(/,$/, '')));
  return en >= 0 ? en : -1;
}

module.exports = {
  getVideoField,
  getFormatBitrate,
  getDurationSeconds,
  getAudioField,
  getSubtitleField,
  getStreamLanguages,
  findGermanAudioIndex,
  findSubtitleIndex,
};
