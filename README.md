<div align="center">
  <h1>Zoom UdeA - Grabaciones</h1>
  <p>Extensión Chrome/Edge para descargar y exportar de forma masiva enlaces de grabaciones de Zoom en la plataforma UdeA (Moodle).</p>
  
  <br>
  <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black" class="inline-block mx-1" style="margin: 0px 2px;">
  <img alt="Chrome Extension V3" src="https://img.shields.io/badge/Chrome_Extension-4285F4?logo=googlechrome&logoColor=white" class="inline-block mx-1" style="margin: 0px 2px;">
  <img alt="HTML5" src="https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white" class="inline-block mx-1" style="margin: 0px 2px;">
  <img alt="GitHub Stars" src="https://img.shields.io/github/stars/Fixer/zoom-udea-recorder" class="inline-block mx-1" style="margin: 0px 2px;">

  <br><br>
  <a href="#-inicio-rápido"><img alt="Inicio Rápido" src="https://img.shields.io/badge/Inicio_Rápido-Click_me-blue" class="inline-block mx-1" style="margin: 0px 2px;"></a>
  <img alt="Status Active" src="https://img.shields.io/badge/Status-Active-brightgreen" class="inline-block mx-1" style="margin: 0px 2px;">
</div>

<hr>

## 🚀 Inicio Rápido

1. **Instalación local:** Clona o descarga este repositorio. Ve a `chrome://extensions/` (o `edge://extensions/`), activa el **Modo desarrollador**, y haz clic en **"Cargar descomprimida"** seleccionando la carpeta del repositorio.
2. **Plataforma UdeA:** Inicia sesión en tu cuenta de Moodle de la UdeA y entra al listado de grabaciones en tu curso.
3. **Uso de la extensión:**
   - Abre el popup de la extensión. Automáticamente leerá la tabla de clases disponibles.
   - **Buscar fechas amplias:** Selecciona el rango de fechas deseado. ¡Si es mayor a 30 días, la extensión buscará silenciosamente en segundo plano sin molestar tu navegación!
   - **Descargas masivas:** Selecciona qué archivos descargar (Video, Transcripción, Chat, Audio) y pulsa **Descargar Todo**. Chrome procesará e interrogará a Zoom pestaña por pestaña. _Nota: Puedes abortar una descarga en curso presionando_ **`Ctrl+Shift+X`** _o haciendo clic en_ **Cancelar Descarga**.
   - **Informes:** Usa los botones de Markdown/TXT. La extensión resolverá cada redirección efímera de Moodle, proporcionándote todos tus links directos a `/rec/play/` en un lindo índice formato texto.

## ⚠️ Requisito Importante (Descarga Silenciosa)

Para que la experiencia sea verdaderamente automática y no tengas que confirmar cada archivo manualmente, **debes desactivar** la siguiente opción en tu navegador:
- Navega a `chrome://settings/downloads` (o `edge://settings/downloads`).
- Desactiva el interruptor **"Preguntar dónde se guardará cada archivo antes de descargarlo"** (*"Ask where to save each file before downloading"*).
La extensión ya nombra y organiza matemáticamente tus archivos y evitará que tu Pantalla se inunde de ventanas de guardado.

---

## 🏗️ Arquitectura General

Componentes principales:

- `manifest.json`: Define permisos, `host_permissions` y configura los Content Scripts y el Service Worker nativo (Manifest V3).
- `popup.html` / `popup.js`: UI principal de la extensión. Controla filtros de fechas asincrónicos, botones de validación y retiene un almacenamiento persistente (`chrome.storage.local`) de logs para diagnósticos sin interrupciones.
- `content.js`: Script inyectado que raspa la base de datos visual de Moodle. Dentro de las páginas generadas de Zoom (`/rec/play/*`), intercepta los modelos integrados simulando clics nativos de descarga para tus opciones exclusivas.
- `background.js`: Service worker global. Orquesta todo el pipeline asincrónico automátizado gestionando el ciclo de vida de pestañas ocultas transitorias, y nombra estandarizadamente los archivos interceptando eventos nativos `chrome.downloads.onDeterminingFilename`.

## 🔐 Permisos y Seguridad (Manifest V3)

- `activeTab`, `scripting`, `downloads`, `storage`, `tabs`
- Host permissions para asegurar interactividad de dominios clave:
  - `https://udearroba.udea.edu.co/*`
  - `https://*.zoom.us/*`

## 🧩 Patrón Estructurado de Archivos

Al iniciar la descarga masiva de las clases, la extensión nombrará nativamente cada archivo con el siguiente esquema para asegurar un ordenamiento impecable en todos los sistemas operativos:

- **Video:** `Clase_{índice}_{fecha ISO}_{duración}min.mp4`
- **Audio:** `Audio_{índice}_{fecha ISO}_{duración}min.m4a`
- **Transcripción:** `Transcripcion_{índice}_{fecha ISO}_{duración}min.vtt`
- **Chat:** `Chat_{índice}_{fecha ISO}_{duración}min.txt`

## 🛠 Puntos Clave para Desarrolladores

- **Fetch Pre-flight Resolver:** El exportador `.md` / `.txt` utiliza llamadas eficientes `HEAD` con `redirect: follow` integradas al DOM para limpiar y deducir endpoints directos sin necesidad de inicializar contenedores de página pesados.
- **Multitasking Ininterrumpido:** Toda la ejecución y lógica robusta es relegada al contexto Background, permitiendo a los usuarios cerrar el popup sin interrumpir lotes de decargas de videos en progreso.
