// background.js — service worker
// Gestiona las descargas por lotes y el estado global

let autoDownloadAbort = false;
let activeDownload = null; // { recording, opts }

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Zoom UdeA] Extensión instalada correctamente.');
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const url = item.url || '';
  
  if (url.startsWith('blob:chrome-extension://')) {
    suggest();
    return;
  }

  if (!activeDownload || !activeDownload.recording) {
    suggest();
    return;
  }

  // FIX: extraer extensión desde el pathname de la URL (ignorar query string)
  // item.filename puede contener el query string completo cuando Chrome no lo limpia
  let urlPathExt = '';
  try {
    const pathname = new URL(url).pathname;
    urlPathExt = (pathname.split('.').pop() || '').toLowerCase();
  } catch (_) {}
  const filenameExt = (item.filename.split('.').pop() || '').toLowerCase();
  // Usar la extensión del pathname si es corta y limpia (ext real), sino fallback al filename
  const originalExt = (urlPathExt.length <= 4 && /^[a-z0-9]+$/.test(urlPathExt)) ? urlPathExt : filenameExt;

  let type = 'video';
  if (['vtt', 'srt'].includes(originalExt) || url.match(/\.(vtt|srt)(\?|$)/i)) type = 'transcript';
  else if (['txt', 'csv'].includes(originalExt) || url.match(/\.(txt|csv)(\?|$)/i)) type = 'chat';
  else if (['m4a', 'mp3', 'wav'].includes(originalExt) || url.match(/\.(m4a|mp3|wav)(\?|$)/i)) type = 'audio';

  console.log(`[Zoom UdeA] onDeterminingFilename — urlPathExt=${urlPathExt} filenameExt=${filenameExt} → type=${type} url=${url.slice(0, 80)}`);

  if (type === 'video' && !activeDownload.opts.video) { suggest({ cancel: true }); return; }
  if (type === 'transcript' && !activeDownload.opts.transcript) { suggest({ cancel: true }); return; }
  if (type === 'chat' && !activeDownload.opts.chat) { suggest({ cancel: true }); return; }
  if (type === 'audio' && !activeDownload.opts.audio) { suggest({ cancel: true }); return; }

  const ext = originalExt || (type === 'video' ? 'mp4' : type === 'transcript' ? 'vtt' : type === 'chat' ? 'txt' : 'm4a');
  const filename = buildFilename(activeDownload.recording, type, ext);
  suggest({ filename, conflictAction: 'uniquify' });

  if (activeDownload.expectedCount) {
    activeDownload.receivedCount = (activeDownload.receivedCount || 0) + 1;
    if (activeDownload.receivedCount >= activeDownload.expectedCount && activeDownload.onAllReceived) {
      if (activeDownload.fallbackTimeout) clearTimeout(activeDownload.fallbackTimeout);
      const cb = activeDownload.onAllReceived;
      activeDownload.onAllReceived = null;
      setTimeout(cb, 500); // Dar 500ms extra para que el gestor interno termine de encolar
    }
  }
});

function buildFilename(rec, type, ext) {
  const idx = String(rec.index).padStart(2, '0');
  const date = rec.date.replace(/[\/\\:*?"<>|]/g, '-');
  const dur = rec.duration ? `_${rec.duration}min` : '';
  
  let prefix = 'Clase';
  if (type === 'transcript') prefix = 'Transcripcion';
  if (type === 'chat') prefix = 'Chat';
  if (type === 'audio') prefix = 'Audio';

  return `${prefix}_${idx}_${date}${dur}.${ext}`;
}



chrome.commands.onCommand.addListener((command) => {
  if (command === 'abort-download') {
    autoDownloadAbort = true;
    activeDownload = null;
    console.log('[Zoom UdeA] Descarga automática abortada por comando.');
  }
});


// Escucha mensajes del popup para acciones que requieren permisos de fondo
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'abortDownload') {
    autoDownloadAbort = true;
    chrome.runtime.sendMessage({ action: 'log', level: 'warn', msg: 'Descarga masiva CANCELADA por el usuario.' });
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'autoDownloadSelected') {
    const files = msg.files || [];
    const rec = msg.recording || { index: 1, topic: 'grabacion', date: 'sin-fecha', duration: null };
    const opts = msg.opts || { video: true, audio: false, transcript: false, chat: false };

    for (const f of files) {
      if (f.type === 'video' && !opts.video) continue;
      if (f.type === 'audio' && !opts.audio) continue;
      if (f.type === 'transcript' && !opts.transcript) continue;
      if (f.type === 'chat' && !opts.chat) continue;

      const filename = buildFilename(rec, f.type, f.ext || (f.type === 'video' ? 'mp4' : f.type === 'transcript' ? 'vtt' : f.type === 'audio' ? 'm4a' : 'txt'));
      chrome.downloads.download({ url: f.url, filename, saveAs: false }, (downloadId) => {
        console.log('[Zoom UdeA] descarga directa', downloadId, filename, f.url);
      });
    }

    sendResponse({ ok: true, count: files.length });
    return true;
  }

  if (msg.action === 'autoDownloadAbort') {
    autoDownloadAbort = true;
    activeDownload = null;
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'autoDownloadBatch') {
    autoDownloadAbort = false;
    activeDownload = null;
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

            const cleanup = () => {
              if (tabClosed) return; // FIX: evitar llamadas duplicadas
              tabClosed = true;
              activeDownload = null; // FIX: limpiar estado global inmediatamente
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
                  activeDownload = { recording: rec, opts };
                  chrome.tabs.sendMessage(tabId, { action: 'clickDownloadButton', opts, recording: rec }, (res) => {
                    if (chrome.runtime.lastError) {
                      chrome.runtime.sendMessage({ action: 'log', level: 'warn', msg: `[${rec.label}] No cargó el script (¿demasiadas recargas?)` });
                      cleanup();
                      return;
                    }
                    if (!res || !res.ok) {
                      chrome.runtime.sendMessage({ action: 'log', level: 'warn', msg: `[${rec.label}] ${res?.error || 'Falló al intentar descargar'}` });
                      cleanup();
                      return;
                    }

                    const req = opts;
                    const found = res.foundTypes || {};

                    // Cuántos tipos pidió el usuario
                    const requested = ['video', 'audio', 'transcript', 'chat'].filter(t => req[t]).length;

                    // FIX: usar totalOffered como fuente de verdad principal.
                    // Los `found` types dependen de detectar checkboxes en la UI de Zoom,
                    // que es frágil y puede devolver false aunque el archivo exista
                    // (ej: el chat aparece como newChat.txt sin checkbox dedicado).
                    // totalOffered viene del número que muestra el botón de descarga "(N)".
                    const totalOffered = res.totalOffered || 0;

                    // expectedCount = mínimo entre lo que el usuario pidió y lo que Zoom ofrece.
                    // Esto evita esperar por tipos que Zoom no tiene, pero no cerramos
                    // la pestaña antes de recibir archivos que Zoom SÍ va a mandar.
                    let expectedCount = Math.min(requested, totalOffered);
                    if (expectedCount === 0) expectedCount = requested; // fallback si totalOffered no se leyó

                    // Log informativo sobre tipos no detectados por checkbox (no son errores reales)
                    const notFoundByCheckbox = ['video', 'audio', 'transcript', 'chat'].filter(t => req[t] && !found[t]);
                    if (notFoundByCheckbox.length > 0) {
                      console.log(`[Zoom UdeA] [${rec.label}] Tipos sin checkbox detectado (pueden existir igual): ${notFoundByCheckbox.join(', ')}`);
                    }

                    chrome.runtime.sendMessage({ action: 'log', level: 'info', msg: `[${rec.label}] Esperando ${expectedCount} archivo(s) (Zoom ofrece ${totalOffered}, usuario pidió ${requested})` });

                    const limit = expectedCount;

                    if (expectedCount === 0) {
                      cleanup();
                    } else {
                      activeDownload.expectedCount = expectedCount;
                      activeDownload.receivedCount = 0;
                      activeDownload.onAllReceived = cleanup;
                      
                      // FIX: limpiar activeDownload antes de llamar cleanup para evitar
                      // que onDeterminingFilename asigne nombres a la siguiente grabación
                      activeDownload.fallbackTimeout = setTimeout(() => {
                        if (activeDownload?.onAllReceived) {
                          chrome.runtime.sendMessage({ action: 'log', level: 'warn', msg: `[${rec.label}] Tiempo agotado esperando ${expectedCount} archivos (ofrecidos: ${limit}). Avanzando...` });
                          activeDownload.onAllReceived = null;
                          activeDownload = null; // FIX: limpiar estado antes de cleanup
                          cleanup();
                        }
                      }, 35000); 
                    }
                  });
                });
              }
            };

            chrome.tabs.onUpdated.addListener(onUpdatedCallback);
            // FIX: el timeout de carga también debe remover el listener antes de cleanup
            setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(onUpdatedCallback);
              cleanup();
            }, 30000);
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
