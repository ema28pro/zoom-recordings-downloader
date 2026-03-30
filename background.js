// background.js — service worker
// Gestiona las descargas por lotes y el estado global

let autoDownloadAbort = false;
// En vez de un estado global único (propenso a carreras),
// guardamos contexto por pestaña (cada grabación corre en su tab oculto).
// Map<tabId, { recording, opts, expectedCount?, receivedCount?, onAllReceived?, fallbackTimeout? }>
const activeDownloadsByTabId = new Map();

// Fallback: en algunos casos Chrome reporta item.tabId indefinido/-1 para descargas
// iniciadas por sitios con redirecciones/descargas "cross-origin".
// Como el batch abre 1 pestaña de Zoom a la vez, podemos usar el contexto actual
// durante una ventana corta sin reintroducir el bug de estado global.
let currentDownloadCtx = null; // { tabId, ctx, startedAt }

/** Popup u otras páginas pueden estar cerradas; sendMessage sin receptor rompe la promesa. */
function safeRuntimeSendMessage(payload) {
  try {
    chrome.runtime.sendMessage(payload, () => void chrome.runtime.lastError);
  } catch (_) {}
}

function logToPopup(level, msg) {
  safeRuntimeSendMessage({ action: 'log', level, msg });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Zoom UdeA] Extensión instalada correctamente.');
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const url = item.url || '';
  
  if (url.startsWith('blob:chrome-extension://')) {
    suggest();
    return;
  }

  const tabId = item.tabId;
  let ctx = (typeof tabId === 'number') ? activeDownloadsByTabId.get(tabId) : null;

  // Fallback: si no hay ctx por tabId, intentar usar el contexto activo si es reciente.
  if (!ctx && currentDownloadCtx?.ctx) {
    const ageMs = Date.now() - (currentDownloadCtx.startedAt || 0);
    if (ageMs >= 0 && ageMs < 90_000) {
      ctx = currentDownloadCtx.ctx;
    }
  }

  if (!ctx || !ctx.recording) {
    suggest();
    return;
  }

  // Detección robusta del tipo: a veces la URL expira y no trae extensión en pathname.
  const { type, ext, debug, confidence } = detectDownloadType(url, item.filename || '', item.mime || '');
  console.log(`[Zoom UdeA] onDeterminingFilename — type=${type} ext=${ext} tabId=${tabId} ${debug} url=${url.slice(0, 140)} filename=${String(item.filename || '').slice(0, 80)}`);

  // Si no podemos identificar con confianza, NO asumimos "video".
  // Esto evita que (por ejemplo) un .txt sin extensión se cuele como video.
  const shouldCancel =
    (type === 'video' && !ctx.opts.video) ||
    (type === 'transcript' && !ctx.opts.transcript) ||
    (type === 'chat' && !ctx.opts.chat) ||
    (type === 'audio' && !ctx.opts.audio) ||
    (type === 'unknown' && (ctx.opts.video !== true || ctx.opts.audio !== true || ctx.opts.transcript !== true || ctx.opts.chat !== true));

  if (shouldCancel) {
    console.warn(`[Zoom UdeA] cancel download — inferredType=${type} confidence=${confidence} tabId=${tabId} url=${url.slice(0, 120)}`);
    // Edge/Chromium: algunas builds validan `filename` como string no vacío incluso con
    // cancel: true; si falla, la descarga sigue con el nombre original (comportamiento que viste).
    suggestCancelDownload(suggest, item, url);
    return;
  }

  let filename = '';
  try {
    filename = buildFilename(ctx.recording, type, ext);
  } catch (e) {
    console.warn('[Zoom UdeA] buildFilename failed, falling back to default name', e);
    suggest();
    return;
  }

  if (typeof filename !== 'string' || filename.trim().length === 0) {
    console.warn('[Zoom UdeA] Empty filename computed, falling back to default name');
    suggest();
    return;
  }

  suggest({ filename, conflictAction: 'uniquify' });

  // Espera basada en "último evento permitido".
  // Así evitamos que cancels/unrecognized types corten descargas tardías (p.ej. transcripción).
  if (ctx?.selectedTypes && Array.isArray(ctx.selectedTypes)) {
    if (ctx.selectedTypes.includes(type)) {
      if (!ctx.typeSeen) ctx.typeSeen = new Set();
      ctx.typeSeen.add(type);
    }
    const allSeen = ctx.typeSeen && ctx.typeSeen.size >= ctx.selectedTypes.length;
    // Solo avanzamos cuando ya vimos todos los tipos permitidos.
    if (allSeen) {
      if (ctx.quietTimeout) clearTimeout(ctx.quietTimeout);
      ctx.quietTimeout = setTimeout(() => {
        if (ctx.onAllReceived) {
          try {
            const recLabel = ctx.recording?.label || 'Grabación';
            logToPopup('info', `[${recLabel}] Avanzando: se recibieron todos los tipos permitidos (tipos=${ctx.selectedTypes.join(', ')})`);
          } catch (_) {}
          ctx.onAllReceived();
        }
      }, 5500); // quiet period para capturar "gemelos" tardíos
    }
  }
});

function detectDownloadType(url, filename, mime) {
  let u;
  try { u = new URL(url); } catch (_) { u = null; }
  const pathname = u?.pathname || '';
  const search = u?.search || '';
  const lowerUrl = (url || '').toLowerCase();
  const lowerFn = (filename || '').toLowerCase();
  const lowerMime = (mime || '').toLowerCase();

  // 1) Extensión explícita (lo más confiable)
  const extFromPath = (pathname.split('.').pop() || '').toLowerCase();
  const extFromFilename = (filename.split('.').pop() || '').toLowerCase();
  const cleanExt = (extFromPath.length <= 4 && /^[a-z0-9]+$/.test(extFromPath)) ? extFromPath : extFromFilename;

  // 2) Señales por parámetros/keywords en URL (cuando no hay extensión)
  const hay = `${pathname} ${search} ${lowerUrl} ${lowerFn}`;
  const looksTranscript = /\b(vtt|srt|subtitle|subtitles|caption|captions|cc|transcript|transcripcion)\b/i.test(hay);
  const looksChat = /\b(chat|meetingchat|newchat)\b/i.test(hay);
  const looksAudio = /\b(audio|m4a|mp3|wav)\b/i.test(hay);

  // 3) MIME (cuando viene disponible) es un buen indicio
  const mimeSaysVideo = lowerMime.startsWith('video/');
  const mimeSaysAudio = lowerMime.startsWith('audio/');
  const mimeSaysText = lowerMime.startsWith('text/');
  const mimeSaysVtt = lowerMime.includes('vtt');

  let type = 'unknown';
  let confidence = 'low';

  if (['vtt', 'srt'].includes(cleanExt) || mimeSaysVtt || looksTranscript) { type = 'transcript'; confidence = cleanExt ? 'high' : (mimeSaysVtt || looksTranscript) ? 'medium' : 'low'; }
  else if (['txt', 'csv'].includes(cleanExt) || (mimeSaysText && looksChat) || looksChat) { type = 'chat'; confidence = cleanExt ? 'high' : (mimeSaysText || looksChat) ? 'medium' : 'low'; }
  else if (['m4a', 'mp3', 'wav'].includes(cleanExt) || mimeSaysAudio || looksAudio) { type = 'audio'; confidence = cleanExt ? 'high' : (mimeSaysAudio || looksAudio) ? 'medium' : 'low'; }
  else if (['mp4', 'webm', 'mov', 'mkv'].includes(cleanExt) || mimeSaysVideo) { type = 'video'; confidence = cleanExt ? 'high' : (mimeSaysVideo ? 'medium' : 'low'); }

  const ext =
    cleanExt ||
    (type === 'video' ? 'mp4' : type === 'transcript' ? 'vtt' : type === 'chat' ? 'txt' : 'm4a');

  const debug = `mime=${lowerMime || '-'} pathExt=${extFromPath || '-'} fnExt=${extFromFilename || '-'} inferred=${type}`;
  return { type, ext, debug, confidence };
}

function safeBasenameFromUrl(urlStr) {
  try {
    const p = new URL(urlStr).pathname;
    const seg = p.split('/').filter(Boolean).pop() || '';
    return seg.split('?')[0] || '';
  } catch (_) {
    return '';
  }
}

/**
 * Cancela la descarga. Debe llamarse exactamente una vez por `suggest`.
 * Edge/Chromium: a veces exigen `filename` no vacío aunque `cancel: true`.
 */
function suggestCancelDownload(suggest, item, url) {
  const placeholder =
    (typeof item.filename === 'string' && item.filename.trim()) ||
    safeBasenameFromUrl(url || item.url || '') ||
    'zoom-udea-cancelled.bin';

  suggest({ cancel: true, filename: placeholder, conflictAction: 'uniquify' });

  // Respaldo: si el motor ignora cancel en downloads cross-origin, intentar cancelar por id.
  if (typeof item.id === 'number' && item.id >= 0) {
    setTimeout(() => {
      chrome.downloads.cancel(item.id, () => void chrome.runtime.lastError);
    }, 0);
  }
}

function buildFilename(rec, type, ext) {
  const safeIndexNum = Number.isFinite(Number(rec?.index)) ? Number(rec.index) : 1;
  const idx = String(safeIndexNum).padStart(2, '0');

  const rawDate = rec?.date || rec?.dateRaw || 'sin-fecha';
  const date = String(rawDate).replace(/[\/\\:*?"<>|]/g, '-');

  const durNum = Number.isFinite(Number(rec?.duration)) ? Number(rec.duration) : null;
  const dur = durNum ? `_${durNum}min` : '';
  
  let prefix = 'Clase';
  if (type === 'transcript') prefix = 'Transcripcion';
  if (type === 'chat') prefix = 'Chat';
  if (type === 'audio') prefix = 'Audio';

  return `${prefix}_${idx}_${date}${dur}.${ext}`;
}



chrome.commands.onCommand.addListener((command) => {
  if (command === 'abort-download') {
    autoDownloadAbort = true;
    activeDownloadsByTabId.clear();
    currentDownloadCtx = null;
    console.log('[Zoom UdeA] Atajo de teclado: abort-download (Ctrl+Shift+X / Command+Shift+X) — cola de descarga detenida.');
    safeRuntimeSendMessage({
      action: 'downloadAbortedByShortcut',
      msg: 'Descarga cancelada con el atajo de teclado (Ctrl+Shift+X).',
    });
  }
});


// Escucha mensajes del popup para acciones que requieren permisos de fondo
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'abortDownload') {
    autoDownloadAbort = true;
    logToPopup('warn', 'Descarga masiva CANCELADA por el usuario.');
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'autoDownloadAbort') {
    autoDownloadAbort = true;
    activeDownloadsByTabId.clear();
    currentDownloadCtx = null;
    console.log('[Zoom UdeA] Mensaje autoDownloadAbort: usuario canceló desde el popup (botón Cancelar).');
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'autoDownloadBatch') {
    autoDownloadAbort = false;
    activeDownloadsByTabId.clear();
    currentDownloadCtx = null;
    (async () => {
      const recordings = msg.recordings || [];
      const opts = msg.opts || { video: true, audio: false, transcript: false, chat: false };

      for (let i = 0; i < recordings.length; i++) {
        if (autoDownloadAbort) {
          sendResponse({ ok: false, reason: 'aborted' });
          return;
        }
        const rec = recordings[i];

        await new Promise((resolve) => {
          chrome.tabs.create({ url: rec.playUrl, active: false }, (tab) => {
            if (chrome.runtime.lastError || !tab) {
              resolve();
              return;
            }
            const tabId = tab.id;
            let tabClosed = false; // FIX: bandera para evitar doble cleanup
            let ctx = null;
            let loadTimeoutId = null;

            const cleanup = () => {
              if (tabClosed) return; // FIX: evitar llamadas duplicadas
              tabClosed = true;
              if (loadTimeoutId != null) {
                clearTimeout(loadTimeoutId);
                loadTimeoutId = null;
              }
              if (ctx?.fallbackTimeout) clearTimeout(ctx.fallbackTimeout);
              if (ctx?.quietTimeout) clearTimeout(ctx.quietTimeout);
              if (typeof tabId === 'number') activeDownloadsByTabId.delete(tabId);
              // Las descargas pueden llegar unos ms después de cerrar la pestaña (tabId -1);
              // retrasar limpieza del fallback para no perder ctx en onDeterminingFilename.
              if (currentDownloadCtx?.tabId === tabId) {
                const clearedTab = tabId;
                setTimeout(() => {
                  if (currentDownloadCtx?.tabId === clearedTab) {
                    currentDownloadCtx = null;
                  }
                }, 8000);
              }
              chrome.tabs.remove(tabId, () => {
                const _ = chrome.runtime.lastError;
                resolve();
              });
            };

            const onUpdatedCallback = (updatedTabId, info) => {
              if (updatedTabId !== tabId) return;
              if (info.status === 'complete') {
                chrome.tabs.get(tabId, (currentTab) => {
                  if (chrome.runtime.lastError || !currentTab.url || !currentTab.url.includes('/rec/play/')) {
                    console.log('[Zoom UdeA] Redirección intermedia, esperando URL de Moodle /rec/play/:', currentTab?.url);
                    return; // Retornamos para esperar el VERDADERO evento complete de la siguiente URL
                  }
                  
                  // Es la página correcta, inyectar!
                  chrome.tabs.onUpdated.removeListener(onUpdatedCallback);
                  ctx = { recording: rec, opts };
                  if (typeof tabId === 'number') activeDownloadsByTabId.set(tabId, ctx);
                  currentDownloadCtx = { tabId, ctx, startedAt: Date.now() };
                  chrome.tabs.sendMessage(tabId, { action: 'clickDownloadButton', opts, recording: rec }, (res) => {
                    if (chrome.runtime.lastError) {
                      logToPopup('warn', `[${rec.label}] No cargó el script (¿demasiadas recargas?)`);
                      cleanup();
                      return;
                    }
                    if (!res || !res.ok) {
                      logToPopup('warn', `[${rec.label}] ${res?.error || 'Falló al intentar descargar'}`);
                      cleanup();
                      return;
                    }

                    const req = opts;
                    const found = res.foundTypes || {};

                    const selectedTypes = ['video', 'audio', 'transcript', 'chat'].filter(t => !!req[t]);
                    if (selectedTypes.length === 0) {
                      cleanup();
                      return;
                    }

                    // Log opcional: algunos tipos pueden no venir reflejados en UI detectada.
                    const notFoundByCheckbox = ['video', 'audio', 'transcript', 'chat'].filter(t => req[t] && !found[t]);
                    if (notFoundByCheckbox.length > 0) {
                      console.debug?.(`[Zoom UdeA] [${rec.label}] Tipos sin checkbox detectado (pueden existir igual): ${notFoundByCheckbox.join(', ')}`);
                    }

                    logToPopup('info', `[${rec.label}] Esperando descargas permitidas (tipos: ${selectedTypes.join(', ')})`);

                    if (loadTimeoutId != null) {
                      clearTimeout(loadTimeoutId);
                      loadTimeoutId = null;
                    }

                    ctx.selectedTypes = selectedTypes;
                    ctx.typeSeen = new Set();
                    ctx.onAllReceived = cleanup;
                    ctx.quietTimeout = null;

                    // Fallback general: si Zoom tarda demasiado en iniciar alguna descarga,
                    // igual avanzamos para no quedarnos pegados.
                    ctx.fallbackTimeout = setTimeout(() => {
                      if (ctx?.onAllReceived) {
                        logToPopup('warn', `[${rec.label}] Timeout general esperando descargas permitidas. Avanzando...`);
                        ctx.onAllReceived = null;
                        cleanup();
                      }
                    }, 180000); // 3 min
                  });
                });
              }
            };

            chrome.tabs.onUpdated.addListener(onUpdatedCallback);
            // Carga inicial: si no hay respuesta del content script, cerrar. Se cancela al empezar a esperar descargas.
            loadTimeoutId = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(onUpdatedCallback);
              cleanup();
            }, 45000);
          });
        });
      }
      if (!autoDownloadAbort) {
        sendResponse({ ok: true, aborted: false });
      }
    })();
    return true;
  }
});
