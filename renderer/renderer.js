'use strict';

const shell = document.getElementById('shell');
const sourcePathEl = document.getElementById('source-path');
const sourceCountEl = document.getElementById('source-count');
const pickPathBtn = document.getElementById('pick-path-btn');

const resolutionSelect = document.getElementById('resolution-select');
const bitrateSelect = document.getElementById('bitrate-select');
const containerSelect = document.getElementById('container-select');
const hardsubCheckbox = document.getElementById('hardsub-checkbox');
const fontRow = document.getElementById('font-row');
const fontInput = document.getElementById('font-input');
const fontList = document.getElementById('font-list');

const overallValueEl = document.getElementById('overall-value');
const overallFillEl = document.getElementById('overall-fill');
const currentFileEl = document.getElementById('current-file');
const fileValueEl = document.getElementById('file-value');
const fileTrackEl = document.getElementById('file-track');
const fileFillEl = document.getElementById('file-fill');
const statusLineEl = document.getElementById('status-line');

const bannerEl = document.getElementById('banner');
const ctaButton = document.getElementById('cta-button');
const ctaLabel = document.getElementById('cta-label');

let selectedPaths = [];
let matchedFiles = [];
let isBusy = false;
let totalFiles = 0;
let completedCount = 0;
let successCount = 0;
let errorCount = 0;

function basename(p) {
  return p.split(/[\\/]/).pop();
}

function setBanner(tone, text) {
  if (!text) {
    bannerEl.className = 'banner';
    bannerEl.textContent = '';
    return;
  }
  bannerEl.className = `banner is-visible`;
  bannerEl.dataset.tone = tone;
  bannerEl.textContent = text;
}

function setBusy(busy) {
  isBusy = busy;
  shell.dataset.busy = String(busy);
  resolutionSelect.disabled = busy;
  bitrateSelect.disabled = busy;
  containerSelect.disabled = busy;
  hardsubCheckbox.disabled = busy;
  fontInput.disabled = busy;
  pickPathBtn.disabled = busy;

  if (busy) {
    ctaButton.dataset.state = 'busy';
    ctaLabel.textContent = 'Abbrechen';
  } else {
    ctaButton.dataset.state = 'idle';
    ctaLabel.textContent = 'Konvertierung starten';
    updateCtaEnabled();
  }
}

function updateCtaEnabled() {
  if (isBusy) return;
  ctaButton.disabled = matchedFiles.length === 0;
}

async function refreshSourceDisplay() {
  if (selectedPaths.length === 0) {
    sourcePathEl.textContent = 'Keine Datei oder Ordner ausgewählt.';
    sourcePathEl.dataset.empty = 'true';
    sourcePathEl.title = '';
    sourceCountEl.textContent = '0 Dateien gefunden';
    matchedFiles = [];
    updateCtaEnabled();
    return;
  }

  const joined = selectedPaths.join(', ');
  sourcePathEl.textContent = joined;
  sourcePathEl.dataset.empty = 'false';
  sourcePathEl.title = joined;

  matchedFiles = await window.videoConverter.previewPaths(selectedPaths);
  const label = matchedFiles.length === 1 ? 'Datei gefunden' : 'Dateien gefunden';
  sourceCountEl.textContent = `${matchedFiles.length} ${label}`;
  updateCtaEnabled();
}

function resetProgress() {
  overallValueEl.textContent = '–';
  overallFillEl.style.width = '0%';
  overallFillEl.classList.remove('is-indeterminate');
  overallTrackReset();
  currentFileEl.textContent = 'Bereit.';
  fileValueEl.textContent = '–';
  fileFillEl.style.width = '0%';
  fileFillEl.classList.remove('is-indeterminate');
  fileTrackEl.classList.remove('is-success', 'is-error');
  statusLineEl.textContent = '';
  statusLineEl.dataset.tone = '';
}

function overallTrackReset() {
  document.getElementById('overall-track').classList.remove('is-success', 'is-error');
}

function updateOverall(fraction) {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  overallFillEl.style.width = `${pct}%`;
  overallValueEl.textContent = `${Math.round(pct)}% · Datei ${Math.min(completedCount + 1, totalFiles)} von ${totalFiles}`;
}

async function init() {
  const [launchPaths, fonts] = await Promise.all([
    window.videoConverter.getLaunchPaths(),
    window.videoConverter.getSystemFonts(),
  ]);

  fontList.innerHTML = '';
  for (const name of fonts) {
    const opt = document.createElement('option');
    opt.value = name;
    fontList.appendChild(opt);
  }
  if (!fonts.includes('DynaPuff')) {
    const opt = document.createElement('option');
    opt.value = 'DynaPuff';
    fontList.appendChild(opt);
  }

  if (launchPaths.length > 0) {
    selectedPaths = launchPaths;
  }
  await refreshSourceDisplay();

  window.videoConverter.onConversionEvent(handleConversionEvent);
}

pickPathBtn.addEventListener('click', async () => {
  const picked = await window.videoConverter.pickPaths();
  if (picked.length > 0) {
    selectedPaths = picked;
    setBanner(null, null);
    await refreshSourceDisplay();
  }
});

hardsubCheckbox.addEventListener('change', () => {
  fontRow.classList.toggle('is-open', hardsubCheckbox.checked);
});

function handleConversionEvent(evt) {
  switch (evt.type) {
    case 'no-files': {
      setBusy(false);
      setBanner('error', 'Keine passenden Videodateien gefunden.');
      break;
    }
    case 'start': {
      totalFiles = evt.total;
      completedCount = 0;
      successCount = 0;
      errorCount = 0;
      resetProgress();
      updateOverall(0);
      break;
    }
    case 'file-start': {
      currentFileEl.textContent = basename(evt.input);
      currentFileEl.title = evt.input;
      fileFillEl.style.width = '0%';
      fileFillEl.classList.add('is-indeterminate');
      fileTrackEl.classList.remove('is-success', 'is-error');
      fileValueEl.textContent = '…';
      statusLineEl.textContent = '';
      statusLineEl.dataset.tone = '';
      break;
    }
    case 'file-progress': {
      if (evt.percent === null || evt.percent === undefined) {
        fileFillEl.classList.add('is-indeterminate');
        fileValueEl.textContent = '…';
      } else {
        fileFillEl.classList.remove('is-indeterminate');
        fileFillEl.style.width = `${evt.percent}%`;
        fileValueEl.textContent = `${Math.round(evt.percent)}%`;
        updateOverall((completedCount + evt.percent / 100) / totalFiles);
      }
      break;
    }
    case 'file-note': {
      statusLineEl.textContent = evt.note;
      statusLineEl.dataset.tone = 'note';
      break;
    }
    case 'file-done': {
      completedCount += 1;
      successCount += 1;
      fileFillEl.classList.remove('is-indeterminate');
      fileFillEl.style.width = '100%';
      fileValueEl.textContent = '100%';
      fileTrackEl.classList.add('is-success');
      statusLineEl.textContent = `Fertig → ${basename(evt.output)}`;
      statusLineEl.dataset.tone = 'success';
      updateOverall(completedCount / totalFiles);
      break;
    }
    case 'file-error': {
      completedCount += 1;
      errorCount += 1;
      fileFillEl.classList.remove('is-indeterminate');
      fileTrackEl.classList.add('is-error');
      statusLineEl.textContent = evt.error;
      statusLineEl.dataset.tone = 'error';
      updateOverall(completedCount / totalFiles);
      break;
    }
    case 'cancelled': {
      setBusy(false);
      setBanner('error', 'Konvertierung abgebrochen.');
      break;
    }
    case 'done': {
      setBusy(false);
      if (errorCount > 0) {
        setBanner('error', `Fertig mit Fehlern: ${successCount} von ${totalFiles} konvertiert, ${errorCount} fehlgeschlagen.`);
      } else {
        setBanner('success', `Fertig: ${successCount} von ${totalFiles} Datei(en) konvertiert.`);
      }
      break;
    }
    case 'fatal-error': {
      setBusy(false);
      setBanner('error', evt.error);
      break;
    }
    default:
      break;
  }
}

ctaButton.addEventListener('click', async () => {
  if (isBusy) {
    await window.videoConverter.cancelConversion();
    return;
  }
  if (matchedFiles.length === 0) {
    setBanner('error', 'Keine Datei oder Ordner ausgewählt.');
    return;
  }

  setBanner(null, null);
  setBusy(true);

  const settings = {
    resolution: resolutionSelect.value,
    bitrateMbps: parseInt(bitrateSelect.value, 10),
    hardcodeSubtitles: hardsubCheckbox.checked,
    subtitleFont: fontInput.value.trim() || 'DynaPuff',
    container: containerSelect.value,
  };

  const result = await window.videoConverter.startConversion(selectedPaths, settings);
  if (!result.started) {
    setBusy(false);
    setBanner('error', result.reason || 'Konvertierung konnte nicht gestartet werden.');
  }
});

init();
