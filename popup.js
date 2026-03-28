// popup.js
// Mover la función $ a la primera línea absoluta para evitar cualquier acceso antes de inicialización
const $ = id => document.getElementById(id);

let recordings = [];   // [{index, topic, date, duration, shareUrl, playUrl}]
let currentTabId = null;

let logHistory = [];

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Cargar logs previos
  chrome.storage.local.get(['extensionLogs'], data => {
    if (data.extensionLogs) {
      logHistory = data.extensionLogs;
      const el = $('log');
      el.innerHTML = '';
      logHistory.forEach(l => {
        const div = document.createElement('div');
        div.className = `log-${l.type}`;
        div.textContent = `[${l.time}] ${l.msg}`;
        el.appendChild(div);
      });
      el.scrollTop = el.scrollHeight;
    }
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg.action === 'log') {
      log(msg.level || 'info', msg.msg);
    }
  });

  setDefaultDates();


  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;

  // Permitir tanto la página de listado como la de reproducción
  const isListPage = tab?.url?.includes('udearroba.udea.edu.co') && tab?.url?.includes('recordingszoom');
  const isPlayPage = tab?.url?.startsWith('https://udearroba.zoom.us/rec/play/');

  if (!isListPage && !isPlayPage) {
    $('status-icon').textContent = '❌';
    $('status-text').textContent = 'No estás en la página correcta.';
    $('not-on-page').style.display = 'block';
    // El botón de simulación solo se habilita en páginas válidas
    const btnSim = $('btn-simulate-download');
    if (btnSim) btnSim.disabled = true;
    return;
  }

  const btnChangeRange = $('btn-change-range');
  if (btnChangeRange) btnChangeRange.disabled = !isListPage;

  const btnSimulateDownload = $('btn-simulate-download');
  if (btnSimulateDownload) btnSimulateDownload.disabled = !isPlayPage;


  // Helper para enviar mensaje al content script con manejo de lastError
  function sendMessageToCurrentTab(message, onResponse) {
    chrome.tabs.sendMessage(currentTabId, message, res => {
      if (chrome.runtime.lastError) {
        const err = chrome.runtime.lastError.message;
        log('error', `No hay content script disponible: ${err}`);
        if (onResponse) onResponse(null, err);
        return;
      }
      if (onResponse) onResponse(res);
    });
  }

  // Botón de prueba para simular clic de descarga en la pestaña activa
  const btnSimulate = $('btn-simulate-download');
  if (btnSimulate) {
    btnSimulate.addEventListener('click', async () => {
      log('info', 'Simulando clic en el botón de descarga en la pestaña activa...');
      sendMessageToCurrentTab({ action: 'simulateDownloadClick' }, (res, err) => {
        if (err) return; // ya logueado
        if (res?.ok) {
          log('ok', 'Clic simulado correctamente.');
        } else {
          log('warn', 'No se encontró el botón de descarga en la página.');
        }
      });
    });
  }

  const btnDownloadAll = $('btn-download-all');
  if (btnDownloadAll) {
    btnDownloadAll.addEventListener('click', async () => {
      const ready = recordings.filter(r => !r.pending);
      if (!ready.length) { log('warn', 'No hay grabaciones listas para descargar.'); return; }

      const opts = {
        video: $('opt-video').checked,
        audio: $('opt-audio').checked,
        transcript: $('opt-transcript').checked,
        chat: $('opt-chat').checked,
      };


      log('info', `Iniciando descarga automática de ${ready.length} grabaciones...`);
      $('btn-download-all').disabled = true;
      $('btn-cancel-download').disabled = false;
      chrome.runtime.sendMessage({
        action: 'autoDownloadBatch',
        recordings: ready,
        opts,
      }, res => {
        if (res?.ok) {
          log('ok', 'Descarga automática completada.');
        } else {
          log('error', 'Error en la descarga automática.');
        }
        $('btn-download-all').disabled = false;
        $('btn-cancel-download').disabled = true;
      });
    });
  }

  const btnCancel = $('btn-cancel-download');
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      chrome.runtime.sendMessage({ action: 'autoDownloadAbort' }, res => {
        if (res?.ok) {
          log('warn', 'Proceso de descarga cancelado.');
          $('btn-download-all').disabled = false;
          btnCancel.disabled = true;
        }
      });
    });
  }

  // Solo pedir grabaciones si estamos en la página de listado
  if (isListPage) {
    await refreshRecordings();
  }
});

// ─── Fechas por defecto ───────────────────────────────────────────────────────
function setDefaultDates() {
  const today = new Date();
  const monthAgo = new Date();
  monthAgo.setDate(today.getDate() - 30);
  // Esperar a que los inputs existan en el DOM
  function fillDates() {
    const from = $('date-from');
    const to = $('date-to');
    if (from && to) {
      to.value = fmtDate(today);
      from.value = fmtDate(monthAgo);
    } else {
      setTimeout(fillDates, 50);
    }
  }
  fillDates();
}

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

// ─── Obtener grabaciones ──────────────────────────────────────────────────────
async function refreshRecordings() {
  log('info', 'Escaneando grabaciones en la página...');
  try {
    const results = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(currentTabId, { action: 'getRecordings' }, results => {
        if (chrome.runtime.lastError) {
          const err = chrome.runtime.lastError.message;
          log('error', `No hay content script disponible: ${err}`);
          $('status-icon').textContent = '❌';
          $('status-text').textContent = 'El content script no está inyectado en esta pestaña.';
          return reject(err);
        }
        if (!results || results.error) {
          log('warn', results?.error || 'No se pudo leer la página.');
          $('status-icon').textContent = '⚠️';
          $('status-text').textContent = 'Error leyendo grabaciones.';
          return reject(results?.error || 'No se pudo leer la página.');
        }
        return resolve(results);
      });
    });

    recordings = results.recordings.slice();
    // Ordenar grabaciones: recientes primero (como en la plataforma)
    recordings.forEach((r, idx) => {
      r.index = idx + 1;
      r.label = `Clase ${r.index} (${r.date})`;
    });

    if (recordings.length === 0) {
      $('status-icon').textContent = '📭';
      $('status-text').textContent = 'No se encontraron grabaciones en este rango.';
      $('recording-count').textContent = '';
      log('warn', 'Sin grabaciones en el rango actual. Prueba cambiando las fechas.');
    } else {
      $('status-icon').textContent = '✅';
      $('status-text').textContent = 'Grabaciones encontradas:';
      $('recording-count').textContent = recordings.length;
      log('ok', `${recordings.length} grabaciones detectadas.`);

      const pending = recordings.filter(r => r.pending);
      if (pending.length) {
        pending.forEach(r => log('warn', `⏳ ${r.label} — aún no procesada (sin enlace)`));
      }
    }

    const hasReady = recordings.some(r => !r.pending);
    $('btn-download-all').disabled = !hasReady;
    $('btn-export-md').disabled = !hasReady;
    $('btn-export-txt').disabled = !hasReady;
  } catch (e) {
    log('error', 'Error de comunicación: ' + (e?.message || e));
    $('status-icon').textContent = '❌';
    $('status-text').textContent = 'Recarga la página e intenta de nuevo.';
  }
}


const btnChangeRange = $('btn-change-range');
if (btnChangeRange) {
  btnChangeRange.addEventListener('click', () => {
    const from = $('date-from').value;
    const to = $('date-to').value;
    if (!from || !to) { log('warn', 'Ingresa un rango de fechas válido.'); return; }

    log('info', `Aplicando rango: ${from} → ${to}`);
    $('status-icon').textContent = '⏳';
    $('status-text').textContent = 'Buscando grabaciones...';
    disableButtons(true);

    chrome.tabs.sendMessage(currentTabId, { action: 'setDateRange', from, to }, res => {
      if (chrome.runtime.lastError) {
        log('error', 'Error de comunicación con la página.');
        disableButtons(false);
        return;
      }
      if (!res || !res.ok) {
        log('error', 'Error buscando en la web: ' + (res?.error || 'Falló de forma silenciosa'));
        disableButtons(false);
        return;
      }

      recordings = (res.recordings || []).slice();
      recordings.forEach((r, idx) => {
        r.index = idx + 1;
        r.label = `Clase ${r.index} (${r.date})`;
      });

      if (recordings.length === 0) {
        $('status-icon').textContent = '📭';
        $('status-text').textContent = 'No se encontraron grabaciones en este rango.';
        $('recording-count').textContent = '';
        log('warn', 'Sin grabaciones en el rango actual.');
      } else {
        $('status-icon').textContent = '✅';
        $('status-text').textContent = 'Grabaciones agrupadas exitosamente:';
        $('recording-count').textContent = recordings.length;
        log('ok', `${recordings.length} grabaciones detectadas en total.`);
      }

      const hasReady = recordings.some(r => !r.pending);
      if (hasReady) {
        $('btn-download-all').disabled = false;
        $('btn-export-md').disabled = false;
        $('btn-export-txt').disabled = false;
      }
      $('btn-change-range').disabled = false;
    });
  });
}



async function resolvePlayUrls(readyList) {
  let resolvedCount = 0;
  for (let i = 0; i < readyList.length; i++) {
    const r = readyList[i];
    if (r.playUrl && r.playUrl.includes('/rec/share/')) {
      try {
        const res = await fetch(r.playUrl, { method: 'HEAD', credentials: 'include' });
        if (res.url && res.url.includes('/rec/play/')) {
          r.playUrl = res.url;
          resolvedCount++;
        }
      } catch (e) {
        console.warn('Fail resolve', r.playUrl, e);
      }
    }
  }
  if (resolvedCount > 0) log('info', `✅ ${resolvedCount} enlaces resueltos permanentemente (/rec/play/)`);
}

// ─── Exportar Markdown ────────────────────────────────────────────────────────
const btnExportMd = $('btn-export-md');
if (btnExportMd) {
  btnExportMd.addEventListener('click', async () => {
    const ready = recordings.filter(r => !r.pending);
    if (!ready.length) { log('warn', 'No hay grabaciones listas.'); return; }

    disableButtons(true);
    $('status-icon').textContent = '🔗';
    $('status-text').textContent = 'Resolviendo enlaces directos...';
    
    await resolvePlayUrls(ready);

    const lines = ['# Grabaciones — ' + ready[0].topic + '\n'];
    lines.push(`> Generado el ${new Date().toLocaleString('es-CO')}\n`);
    lines.push('| # | Fecha | Duración | Enlace |');
    lines.push('|---|-------|----------|--------|');
    ready.forEach(r => {
      const dur = r.duration ? `${r.duration} min` : '—';
      const link = `[Ver grabación](${r.playUrl})`;
      lines.push(`| ${r.index} | ${r.date} | ${dur} | ${link} |`);
    });

    const pending = recordings.filter(r => r.pending);
    if (pending.length) {
      lines.push('\n## ⏳ Grabaciones aún no procesadas\n');
      pending.forEach(r => lines.push(`- ${r.label} — fecha: ${r.date}`));
    }

    const filenameMd = buildExportFilename(ready[0].topic, 'md');
    download(lines.join('\n'), filenameMd, 'text/markdown');
    log('ok', `Markdown exportado con ${ready.length} grabaciones directas.`);
    
    $('status-icon').textContent = '✅';
    $('status-text').textContent = 'Listo';
    disableButtons(false);
  });
}

// ─── Exportar TXT ─────────────────────────────────────────────────────────────
const btnExportTxt = $('btn-export-txt');
if (btnExportTxt) {
  btnExportTxt.addEventListener('click', async () => {
    const ready = recordings.filter(r => !r.pending);
    if (!ready.length) { log('warn', 'No hay grabaciones listas.'); return; }

    disableButtons(true);
    $('status-icon').textContent = '🔗';
    $('status-text').textContent = 'Resolviendo enlaces directos...';

    await resolvePlayUrls(ready);

    const lines = [`GRABACIONES — ${ready[0].topic}`, `Exportado: ${new Date().toLocaleString('es-CO')}`, ''];
    ready.forEach(r => {
      const dur = r.duration ? ` | ${r.duration} min` : '';
      const link = r.playUrl || '(sin enlace)';
      lines.push(`[Clase ${r.index}] ${r.date}${dur}`);
      lines.push(`  → ${link}`);
      lines.push('');
    });

    const pending = recordings.filter(r => r.pending);
    if (pending.length) {
      lines.push('--- PENDIENTES (sin procesar) ---');
      pending.forEach(r => lines.push(`⏳ ${r.label} | ${r.date}`));
    }

    const filenameTxt = buildExportFilename(ready[0].topic, 'txt');
    download(lines.join('\n'), filenameTxt, 'text/plain');
    log('ok', `TXT exportado con ${ready.length} grabaciones directas.`);
    
    $('status-icon').textContent = '✅';
    $('status-text').textContent = 'Listo';
    disableButtons(false);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Sanitiza el topic para usarlo como nombre de archivo
function buildExportFilename(topic, ext) {
  const safe = (topic || 'grabaciones')
    .replace(/[<>:"\/\\|?*]/g, '')  // caracteres inválidos en Windows/Mac
    .replace(/\s+/g, ' ')             // espacios múltiples → uno
    .trim()
    .slice(0, 80);                      // máx 80 chars
  return `Grabaciones — ${safe}.${ext}`;
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);

  // Usar <a download> en lugar de chrome.downloads.download para blobs:
  // chrome.downloads con blob URLs pasa por onDeterminingFilename donde
  // el filename puede ser ignorado. El tag <a> respeta el atributo download
  // y garantiza la extensión correcta.
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function log(type, msg) {
  const el = $('log');
  const div = document.createElement('div');
  div.className = `log-${type}`;
  const time = new Date().toLocaleTimeString('es-CO');
  div.textContent = `[${time}] ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  // Limitar a 80 líneas
  while (el.children.length > 80) el.removeChild(el.firstChild);
  
  // Guardar permanente
  logHistory.push({ type, msg, time });
  if (logHistory.length > 80) logHistory.shift();
  chrome.storage.local.set({ extensionLogs: logHistory });
}

function showProgress(show) {
  $('progress-section').style.display = show ? 'block' : 'none';
}

function updateProgress(done, total, text) {
  const pct = Math.round((done / total) * 100);
  $('progress-fill').style.width = pct + '%';
  $('progress-text').textContent = `${text} (${pct}%)`;
}

// FIX: usar optional chaining para evitar TypeError si algún botón no existe en el DOM
function disableButtons(dis) {
  ['btn-download-all', 'btn-export-md', 'btn-export-txt', 'btn-change-range'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = dis;
  });
}
