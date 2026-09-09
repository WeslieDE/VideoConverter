'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const probe = require('./ffprobe');

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'm4v', 'wmv', 'flv', 'ts', 'mpg', 'mpeg'];
const OUTPUT_SUFFIX = 'small';

const RESOLUTION_MAX_HEIGHT = {
  original: null,
  '720p': 720,
  '1080p': 1080,
  '4k': 2160,
};

const BITMAP_SUBTITLE_CODECS = new Set(['dvd_subtitle', 'dvb_subtitle', 'hdmv_pgs_subtitle', 'xsub']);

function isVideoFile(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

function isAlreadyConverted(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  return new RegExp(`_${OUTPUT_SUFFIX}$`, 'i').test(base);
}

// Sammelt zu konvertierende Dateien: Dateien direkt übernehmen, Ordner
// werden (nicht rekursiv) nach Videodateien durchsucht. Bereits konvertierte
// Ausgabedateien (*_small.*) werden übersprungen.
function collectFiles(inputPaths) {
  const files = [];
  for (const entry of inputPaths) {
    let stat;
    try {
      stat = fs.statSync(entry);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      let names;
      try {
        names = fs.readdirSync(entry);
      } catch {
        continue;
      }
      names.sort((a, b) => a.localeCompare(b, 'de'));
      for (const name of names) {
        const full = path.join(entry, name);
        let fileStat;
        try {
          fileStat = fs.statSync(full);
        } catch {
          continue;
        }
        if (!fileStat.isFile() || !isVideoFile(full) || isAlreadyConverted(full)) continue;
        files.push(full);
      }
    } else if (stat.isFile()) {
      files.push(entry);
    }
  }
  return files;
}

function outputPathFor(input, container) {
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  return path.join(dir, `${base}_${OUTPUT_SUFFIX}.${container}`);
}

function escapeForSubtitleFilter(value) {
  return value.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function parseIntOrNull(value) {
  if (value === null || value === undefined || value === 'N/A') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

function tempFile(suffix) {
  return path.join(os.tmpdir(), `video-verkleinern-${crypto.randomBytes(8).toString('hex')}${suffix}`);
}

function extractSubtitleToSrt(input, subtitleIndex, srtPath) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-y', '-i', input, '-map', `0:s:${subtitleIndex}`, '-c:s', 'srt', srtPath], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

// Ermittelt die ffmpeg-Argumente für eine einzelne Datei anhand der
// Benutzer-Einstellungen (Auflösung/Bitrate/Hardsub/Font/Container).
// Übernimmt die Kernlogik von video-verkleinern.sh: nie hochskalieren/
// -bitraten, deutsche Tonspur bevorzugen, AAC-Stereo/yuv420p/High-Profile/
// gerade Dimensionen/faststart für Mobile-Kompatibilität.
async function buildPlan(input, settings) {
  const origHeightRaw = (await probe.getVideoField(input, 'height').catch(() => null));
  const origHeight = parseIntOrNull(origHeightRaw);
  if (!origHeight) {
    throw new Error('Konnte Videostream nicht lesen (kein Video-Stream gefunden).');
  }

  let origBitrate = parseIntOrNull(await probe.getVideoField(input, 'bit_rate').catch(() => null));
  if (!origBitrate) {
    origBitrate = parseIntOrNull(await probe.getFormatBitrate(input).catch(() => null));
  }

  const maxHeight = RESOLUTION_MAX_HEIGHT[settings.resolution];
  let scaleFilter = '';
  let targetHeight = origHeight;
  if (maxHeight && origHeight > maxHeight) {
    targetHeight = maxHeight;
    scaleFilter = `scale=-2:${targetHeight}`;
  } else {
    scaleFilter = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  }

  const maxBitrate = settings.bitrateMbps * 1_000_000;
  const targetBitrate = !origBitrate || origBitrate > maxBitrate ? maxBitrate : origBitrate;
  const bufsize = targetBitrate * 2;

  const mapArgs = ['-map', '0:v:0'];
  let audioArgs = [];
  const audioIdx = await probe.findGermanAudioIndex(input);
  if (audioIdx >= 0) {
    mapArgs.push('-map', `0:a:${audioIdx}`);
    const audioCodec = await probe.getAudioField(input, audioIdx, 'codec_name').catch(() => null);
    const audioChannels = await probe.getAudioField(input, audioIdx, 'channels').catch(() => null);
    if (audioCodec === 'aac' && audioChannels === '2') {
      audioArgs = ['-c:a', 'copy'];
    } else {
      let audioBitrate = parseIntOrNull(await probe.getAudioField(input, audioIdx, 'bit_rate').catch(() => null));
      if (!audioBitrate || audioBitrate < 128000) audioBitrate = 192000;
      else if (audioBitrate > 320000) audioBitrate = 320000;
      audioArgs = ['-c:a', 'aac', '-b:a', String(audioBitrate), '-ac', '2'];
    }
  }

  let vfChain = scaleFilter;
  let subtitleTemp = null;
  let subtitleInfo = null;
  if (settings.hardcodeSubtitles) {
    const subIdx = await probe.findSubtitleIndex(input);
    if (subIdx >= 0) {
      const subCodec = await probe.getSubtitleField(input, subIdx, 'codec_name').catch(() => null);
      if (subCodec && BITMAP_SUBTITLE_CODECS.has(subCodec)) {
        subtitleInfo = { skipped: true, reason: `Bitmap-Format (${subCodec}) kann nicht als Hardsub eingebrannt werden.` };
      } else {
        const srtPath = tempFile('.srt');
        const ok = await extractSubtitleToSrt(input, subIdx, srtPath);
        if (ok) {
          subtitleTemp = srtPath;
          const escaped = escapeForSubtitleFilter(srtPath);
          vfChain += `,subtitles='${escaped}':charenc=UTF-8:force_style='FontName=${settings.subtitleFont}'`;
          subtitleInfo = { skipped: false };
        } else {
          try { fs.unlinkSync(srtPath); } catch { /* ignore */ }
          subtitleInfo = { skipped: true, reason: 'Untertitel konnte nicht extrahiert werden.' };
        }
      }
    }
  }

  const duration = await probe.getDurationSeconds(input).catch(() => null);
  const output = outputPathFor(input, settings.container);

  const ffmpegArgs = ['-y', '-hwaccel', 'cuda', '-i', input, ...mapArgs, '-vf', vfChain, '-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '23', '-r', '25', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.1', '-b:v', String(targetBitrate), '-maxrate', String(targetBitrate), '-bufsize', String(bufsize), ...audioArgs, '-sn'];
  if (settings.container === 'mp4') {
    ffmpegArgs.push('-movflags', '+faststart');
  }
  ffmpegArgs.push('-progress', 'pipe:1', '-nostats', output);

  return {
    input,
    output,
    ffmpegArgs,
    duration,
    subtitleTemp,
    subtitleInfo,
    targetHeight,
    targetBitrate,
  };
}

function runFfmpeg(ffmpegArgs, onTimeUs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    let buffer = '';

    const onAbort = () => {
      child.kill('SIGKILL');
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const m = line.match(/^out_time_us=(-?\d+)/);
        if (m) onTimeUs(parseInt(m[1], 10));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrTail += chunk.toString('utf8');
      if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);
    });
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) {
        reject(Object.assign(new Error('cancelled'), { cancelled: true }));
      } else if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg beendet mit Code ${code}: ${stderrTail.slice(-800)}`));
      }
    });
  });
}

// Konvertiert eine Liste von Datei-/Ordnerpfaden gemäß den Einstellungen.
// Ruft onEvent(event) für Fortschritts-Updates auf. signal (AbortSignal)
// erlaubt den Abbruch der laufenden Konvertierung.
async function convertAll(inputPaths, settings, onEvent, signal) {
  const files = collectFiles(inputPaths);
  if (files.length === 0) {
    onEvent({ type: 'no-files' });
    return;
  }

  onEvent({ type: 'start', total: files.length, files });

  for (let i = 0; i < files.length; i++) {
    if (signal && signal.aborted) {
      onEvent({ type: 'cancelled' });
      return;
    }
    const input = files[i];
    onEvent({ type: 'file-start', index: i, total: files.length, input });

    let plan;
    try {
      plan = await buildPlan(input, settings);
    } catch (err) {
      onEvent({ type: 'file-error', index: i, total: files.length, input, error: err.message });
      continue;
    }

    if (plan.subtitleInfo && plan.subtitleInfo.skipped) {
      onEvent({ type: 'file-note', index: i, total: files.length, input, note: plan.subtitleInfo.reason });
    }

    onEvent({
      type: 'file-progress',
      index: i,
      total: files.length,
      input,
      output: plan.output,
      percent: 0,
    });

    try {
      await runFfmpeg(plan.ffmpegArgs, (timeUs) => {
        let percent = null;
        if (plan.duration && plan.duration > 0) {
          percent = Math.max(0, Math.min(99, (timeUs / 1_000_000 / plan.duration) * 100));
        }
        onEvent({
          type: 'file-progress',
          index: i,
          total: files.length,
          input,
          output: plan.output,
          percent,
        });
      }, signal);

      onEvent({ type: 'file-done', index: i, total: files.length, input, output: plan.output });
    } catch (err) {
      if (err.cancelled) {
        try { fs.unlinkSync(plan.output); } catch { /* ignore */ }
        if (plan.subtitleTemp) { try { fs.unlinkSync(plan.subtitleTemp); } catch { /* ignore */ } }
        onEvent({ type: 'cancelled' });
        return;
      }
      onEvent({ type: 'file-error', index: i, total: files.length, input, error: err.message });
    }

    if (plan.subtitleTemp) {
      try { fs.unlinkSync(plan.subtitleTemp); } catch { /* ignore */ }
    }
  }

  onEvent({ type: 'done' });
}

module.exports = {
  VIDEO_EXTENSIONS,
  collectFiles,
  convertAll,
};
