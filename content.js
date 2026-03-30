// content.js — se inyecta en udearroba.udea.edu.co/.../recordingszoom/...

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'clickDownloadButton') {
    const { opts, recording } = msg;
    
    simulateDownloadClick(opts, (result) => {
      if (!result.clicked) {
        sendResponse({ ok: false, error: 'No hay botón de descarga disponible en Zoom.' });
        return;
      }
      
      // Importante: no disparamos descargas "directas" desde anchors porque eso
      // duplica/bypassea el filtrado y el renombrado centralizado en background.js.
      // La única fuente de verdad de filtrado/renombrado será onDeterminingFilename.
      sendResponse({ ok: true, foundTypes: result.found, totalOffered: result.totalOffered });
    });

    return true;
  }

  // FIX: manejar la acción 'simulateDownloadClick' que el popup envía desde el botón de prueba
  if (msg.action === 'simulateDownloadClick') {
    simulateDownloadClick({}, (result) => {
      sendResponse({ ok: result.clicked });
    });
    return true;
  }

  if (msg.action === 'getRecordings') {
    sendResponse({ recordings: scrapeRecordings() });
    return true;
  }
  if (msg.action === 'setDateRange') {
    applyDateRange(msg.from, msg.to, sendResponse);
    return true;
  }

});
// ─── Simular clic en el botón de descarga en /rec/play/ ─────────────────────
function simulateDownloadClick(opts, onDone) {
  function tryClick(retries = 10) {
    const btn = document.querySelector('a.download-btn');
    if (btn) {
      let totalOffered = 1;
      const match = btn.textContent.match(/\((\d+)/);
      if (match) totalOffered = parseInt(match[1], 10);
      // En algunas instancias de Zoom no existe modal ni checkboxes; este <a>
      // simplemente dispara N descargas/URLs efímeras. Hacemos 1 click y dejamos
      // que background.js filtre/renombre por onDeterminingFilename.
      btn.click();
      onDone({ clicked: true, found: null, totalOffered });
      return;
    }
    if (retries > 0) {
      setTimeout(() => tryClick(retries - 1), 200);
      return;
    }
    onDone({ clicked: false });
  }
  tryClick();
}

// ─── Extraer grabaciones de la tabla ──────────────────────────────────────────
function scrapeRecordings(doc = document) {
  const rows = doc.querySelectorAll('table.mod_view tbody tr');
  const result = [];
  // Recorrer de abajo hacia arriba para que la más reciente sea la primera
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    const cells = row.querySelectorAll('td');
    if (cells.length < 5) continue;

    const topic = cells[1]?.textContent?.trim() || 'Sin título';
    const dateRaw = cells[2]?.textContent?.trim() || '';
    const durRaw = cells[3]?.textContent?.trim() || '';
    const formEl = cells[4]?.querySelector('form');

    const dateFormatted = formatDate(dateRaw);
    const duration = parseInt(durRaw) || null;

    const redirectInput = formEl?.querySelector('input[name="zoomplayredirect"]');
    const shareUrl = redirectInput?.value || null;

    const pending = !shareUrl;

    // FIX: índice calculado una sola vez aquí; popup.js lo renumerará de todas formas,
    // pero lo dejamos coherente para no confundir logs intermedios.
    const position = rows.length - i; // 1 para la más reciente

    result.push({
      index: position,
      topic: topic.replace(/#.*$/, '').trim(),
      date: dateFormatted,
      dateRaw,
      duration,
      shareUrl,
      playUrl: shareUrl,
      label: `Clase ${position} (${dateFormatted})`,
      pending,
    });
  }
  return result;
}

function formatDate(raw) {
  // raw puede ser "2026-03-27T21:08:24Z"
  if (!raw) return 'Sin fecha';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw.slice(0, 10);
  return d.toLocaleDateString('es-CO', {
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).replace(/\//g, '-');
}

// ─── Cambiar rango de fechas (rellenar formulario y enviar) ───────────────────
function applyDateRange(from, to, sendResponse) {
  try {
    const form = document.querySelector('form[action*="recordinglist.php"]') || document.querySelector('form.mform');
    if (!form) {
      sendResponse({ ok: false, error: 'No se encontró el formulario de búsqueda de grabaciones.' });
      return;
    }

    // Cambiar UI
    setFormDate(form, 'from', from);
    setFormDate(form, 'to', to);

    // Fetch asincrónico por partes
    fetchRecordingsForRange(form, from, to)
      .then(recordings => sendResponse({ ok: true, recordings }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function fetchRecordingsForRange(form, fromStr, toStr) {
  const url = form.action || window.location.href;
  const fromDate = new Date(fromStr + 'T12:00:00Z');
  const toDate = new Date(toStr + 'T12:00:00Z');
  if (isNaN(fromDate) || isNaN(toDate)) throw new Error('Fechas inválidas');

  const chunks = [];
  let current = new Date(fromDate);
  
  while (current <= toDate) {
    let chunkEnd = new Date(current);
    chunkEnd.setDate(current.getDate() + 30);
    if (chunkEnd > toDate) chunkEnd = new Date(toDate);
    
    chunks.push({
      from: current.toISOString().split('T')[0],
      to: chunkEnd.toISOString().split('T')[0]
    });
    
    current = new Date(chunkEnd);
    current.setDate(current.getDate() + 1);
  }

  const baseData = new FormData(form);
  const allRecordings = [];

  // Recorrer del último fragmento al primero para mantener orden de fecha más reciente a más antigua
  for (let i = chunks.length - 1; i >= 0; i--) {
    const chunk = chunks[i];
    console.log(`[Zoom UdeA] Buscando bloque: ${chunk.from} a ${chunk.to}`);
    
    const fd = new FormData();
    for (const [k, v] of baseData.entries()) {
      if (!k.startsWith('from[') && !k.startsWith('to[')) {
        fd.append(k, v);
      }
    }
    
    const [fY, fM, fD] = chunk.from.split('-');
    const [tY, tM, tD] = chunk.to.split('-');
    fd.append('from[day]', parseInt(fD, 10));
    fd.append('from[month]', parseInt(fM, 10));
    fd.append('from[year]', fY);
    fd.append('to[day]', parseInt(tD, 10));
    fd.append('to[month]', parseInt(tM, 10));
    fd.append('to[year]', tY);

    const res = await fetch(url, {
      method: 'POST',
      body: fd,
      credentials: 'same-origin'
    });
    
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    
    const chunkRecs = scrapeRecordings(doc);
    allRecordings.push(...chunkRecs);
  }

  // Deduplicar si hay solapes en los bordes de los fragmentos  
  const seenUrls = new Set();
  const deduped = [];
  for (const rec of allRecordings) {
    const id = rec.playUrl || (rec.topic + rec.dateRaw);
    if (!seenUrls.has(id)) {
      seenUrls.add(id);
      deduped.push(rec);
    }
  }

  return deduped;
}

function setFormDate(form, prefix, isoDate) {
  // isoDate = "YYYY-MM-DD"
  const [y, m, d] = isoDate.split('-').map(Number);
  const selDay = form.querySelector(`select[name="${prefix}[day]"]`);
  const selMonth = form.querySelector(`select[name="${prefix}[month]"]`);
  const selYear = form.querySelector(`select[name="${prefix}[year]"]`);
  if (selDay) selDay.value = d;
  if (selMonth) selMonth.value = m;
  if (selYear) selYear.value = y;

  // Moodle suele enganchar listeners a change; disparamos eventos para que la UI
  // refleje el rango aplicado aunque usemos fetch en background.
  [selDay, selMonth, selYear].filter(Boolean).forEach(el => {
    try {
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (_) {}
  });
}
