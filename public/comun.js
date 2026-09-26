// Utilidades compartidas entre la vista del personal y el C2
const COLORES = { ATAQUE: '#ff3b3b', AMENAZA: '#ffb020', DESPEJADO: '#3ecf8e' };
const ESTADO_TXT = { ACTIVA: 'ACTIVA', RESUELTA: 'RESUELTA', FALSA_ALARMA: 'FALSA ALARMA' };
const CENTRO_INICIAL = [4.65, -74.1]; // Bogotá (cambiar a la base correspondiente)

function fechaCorta(iso) {
  const d = new Date(iso);
  const M = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
  const z = n => String(n).padStart(2, '0');
  return `${z(d.getDate())} ${M[d.getMonth()]} ${z(d.getHours())}:${z(d.getMinutes())}`;
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function crearMapa(id) {
  const m = L.map(id, { zoomControl: true, attributionControl: true }).setView(CENTRO_INICIAL, 11);
  // Mapa base oscuro de Esri (gratis, sin API key). Si la red lo bloquea, pasa a OpenStreetMap oscurecido.
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/';
  const FUENTES = [
    { url: ESRI + 'World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', etiquetas: ESRI + 'World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      attr: '&copy; Esri, HERE, Garmin, &copy; OpenStreetMap', max: 16, clase: '' },
    { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attr: '&copy; OpenStreetMap', max: 19, clase: 'teselas-oscuras' }
  ];
  let i = 0, capa = null, rotulos = null, errores = 0, cargadas = 0;
  function usar(n) {
    if (capa) m.removeLayer(capa); if (rotulos) m.removeLayer(rotulos);
    errores = 0; cargadas = 0;
    const f = FUENTES[n];
    m.setMaxZoom(f.max);
    capa = L.tileLayer(f.url, { maxZoom: f.max, attribution: f.attr, className: f.clase, referrerPolicy: 'strict-origin-when-cross-origin' });
    capa.on('tileload', () => cargadas++);
    capa.on('tileerror', () => {
      errores++;
      if (errores >= 4 && cargadas === 0 && i < FUENTES.length - 1) { console.warn('Mapa: fuente bloqueada, probando otra'); usar(++i); }
    });
    capa.addTo(m);
    if (f.etiquetas) {
      if (!m.getPane('rotulos')) { const p = m.createPane('rotulos'); p.style.zIndex = 350; p.style.pointerEvents = 'none'; }
      rotulos = L.tileLayer(f.etiquetas, { maxZoom: f.max, pane: 'rotulos' }).addTo(m);
    }
  }
  usar(0);
  return m;
}

function dibujarZona(mapa, a, capa) {
  const color = COLORES[a.nivel] || '#8b95a3';
  const activa = a.estado === 'ACTIVA';
  const c = L.circle([a.zona.lat, a.zona.lng], {
    radius: a.zona.radio, color, weight: 2, fillColor: color, fillOpacity: activa ? .25 : .06, opacity: activa ? 1 : .35,
    dashArray: a.modo === 'SIMULACRO' ? '6 6' : null
  }).bindPopup(`<b>${esc(a.titulo)}</b><br>${esc(a.zona.nombre)}<br>${fechaCorta(a.creada)}`);
  c.addTo(capa);
  return c;
}

// ---- Sirena generada con Web Audio (no requiere archivos de sonido) ----
const Sirena = {
  ctx: null, osc: null, gain: null, timer: null,
  desbloquear() { if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)(); if (this.ctx.state === 'suspended') this.ctx.resume(); },
  iniciar(nivel) {
    this.detener(); if (!this.ctx) return;
    this.osc = this.ctx.createOscillator(); this.gain = this.ctx.createGain();
    this.osc.type = 'sawtooth'; this.gain.gain.value = .35;
    this.osc.connect(this.gain).connect(this.ctx.destination); this.osc.start();
    const lento = nivel !== 'ATAQUE'; let alto = false;
    const paso = () => { const t = this.ctx.currentTime; this.osc.frequency.cancelScheduledValues(t);
      this.osc.frequency.linearRampToValueAtTime(alto ? 600 : 1300, t + (lento ? 1.2 : .45)); alto = !alto; };
    paso(); this.timer = setInterval(paso, lento ? 1200 : 450);
    if (nivel === 'DESPEJADO') setTimeout(() => this.detener(), 2500);
  },
  detener() { clearInterval(this.timer); try { this.osc && this.osc.stop(); } catch {} this.osc = null; }
};
