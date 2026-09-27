// ===== Vista del personal =====
const $ = s => document.querySelector(s);
let token = localStorage.getItem('tokenPersonal');
let perfil = JSON.parse(localStorage.getItem('perfilPersonal') || 'null');
const vistas = new Set(JSON.parse(localStorage.getItem('alertasVistas') || '[]'));
let alertaEnPantalla = null;

const mapa = crearMapa('mapa');
const capa = L.layerGroup().addTo(mapa);

// ---------- Cargar y pintar alertas ----------
let datos = { activas: [], historial: [] };
async function cargar() {
  if (!token) { datos = { activas: [], historial: [] }; pintar(); return; }
  const r = await fetch('/api/alertas', { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 401) return cerrarSesion('Su inscripción ya no es válida. Inscríbase de nuevo.');
  datos = await r.json(); pintar();
  // Si se abre la app desde la notificación, mostrar la alerta activa no vista
  const pendiente = datos.activas.find(a => !vistas.has(a.id));
  if (pendiente) mostrarAlarma(pendiente);
}
function pintar() {
  capa.clearLayers();
  const todas = [...datos.activas, ...datos.historial.slice(0, 10)];
  todas.forEach(a => dibujarZona(mapa, a, capa));
  const top = datos.activas.find(a => a.nivel === 'ATAQUE') || datos.activas[0];
  const est = $('#estado'); est.className = 'estado ' + (top ? top.nivel : '');
  $('#estadoIcono').innerHTML = top
    ? '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'
    : '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z"/><path d="m9 12 2 2 4-4"/>';
  if (top) {
    $('#estadoTit').textContent = top.titulo;
    $('#estadoTxt').textContent = top.instruccion + ' · Zona: ' + top.zona.nombre;
    mapa.flyTo([top.zona.lat, top.zona.lng], 13);
  } else {
    $('#estadoTit').textContent = token ? 'Sin amenazas activas' : 'Inscríbase para recibir alertas';
    $('#estadoTxt').textContent = token ? 'Mantén los avisos activados para enterarte al instante.' : 'Use el código que le entregó su unidad (abajo).';
  }
  const lista = [...datos.activas, ...datos.historial];
  $('#historial').innerHTML = lista.length ? lista.map(a => `
    <div class="item"><div class="meta mono"><span class="punto ${a.estado}"></span>${ESTADO_TXT[a.estado]} · ${fechaCorta(a.creada)}</div>
    <b>${esc(a.titulo)}</b><div class="vacio">${esc(a.zona.nombre)}</div></div>`).join('')
    : `<div class="vacio">${token ? 'Sin alertas registradas para su unidad.' : 'Inscríbase para ver el historial de su unidad.'}</div>`;
}

// ---------- Tiempo real ----------
const socket = io();
socket.on('connect', () => { if (token) socket.emit('unirse', token); $('#conexion').textContent = 'EN VIVO'; $('#vivo').classList.remove('off'); cargar(); });
socket.on('disconnect', () => { $('#conexion').textContent = 'SIN CONEXIÓN'; $('#vivo').classList.add('off'); });
socket.on('alerta:nueva', a => { datos.activas.unshift(a); pintar(); mostrarAlarma(a); });
socket.on('alerta:actualizada', a => {
  datos.activas = datos.activas.filter(x => x.id !== a.id);
  datos.historial = [a, ...datos.historial.filter(x => x.id !== a.id)]; pintar();
  if (alertaEnPantalla && alertaEnPantalla.id === a.id) {
    Sirena.detener(); $('#aOk').textContent = a.estado === 'FALSA_ALARMA' ? 'EL CCOSD CANCELÓ ESTA ALERTA (FALSA ALARMA)' : 'ALERTA FINALIZADA';
    $('#aOk').classList.remove('oculto'); $('#aBotones').classList.add('oculto'); $('#aCerrar').classList.remove('oculto');
  }
});

// ---------- Pantalla de alarma ----------
function mostrarAlarma(a) {
  alertaEnPantalla = a; vistas.add(a.id); localStorage.setItem('alertasVistas', JSON.stringify([...vistas].slice(-100)));
  const el = $('#alarma'); el.className = `alarma ${a.nivel} ${a.modo}`;
  $('#aEtiq').textContent = (a.modo === 'SIMULACRO' ? '⚠ SIMULACRO · ' : '') + 'ALERTA UAS · ' + fechaCorta(a.creada);
  $('#aTit').textContent = a.titulo.replace('SIMULACRO · ', '');
  $('#aInstr').textContent = a.instruccion;
  $('#aMsg').textContent = a.mensaje || '';
  $('#aZona').textContent = 'ZONA: ' + a.zona.nombre.toUpperCase();
  const puedeConfirmar = !!token && a.nivel !== 'DESPEJADO';
  $('#aBotones').classList.toggle('oculto', !puedeConfirmar);
  $('#aCerrar').classList.toggle('oculto', puedeConfirmar);
  $('#aOk').classList.toggle('oculto', puedeConfirmar);
  $('#aOk').textContent = token ? '' : 'Inscríbase para poder confirmar su estado al CCOSD.';
  const suena = Sirena.iniciar(a.nivel);
  // Si el navegador bloqueó el sonido (típico en iPhone al abrir desde la notificación), pedir un toque
  $('#aSonido').classList.toggle('oculto', suena || a.nivel === 'DESPEJADO');
  setTimeout(revisarSonido, 400);
  if (navigator.vibrate) navigator.vibrate(a.nivel === 'ATAQUE' ? [600, 200, 600, 200, 600, 200, 600] : [400, 300, 400]);
}
document.querySelectorAll('#aBotones button').forEach(b => b.onclick = async () => {
  Sirena.detener(); $('#aSonido').classList.add('oculto');
  const r = await fetch(`/api/alertas/${alertaEnPantalla.id}/confirmar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ estado: b.dataset.e })
  });
  $('#aOk').textContent = r.ok ? '✓ ESTADO ENVIADO AL CCOSD: ' + b.textContent.toUpperCase() : 'No se pudo enviar. Reintente.';
  $('#aOk').classList.remove('oculto');
  if (r.ok) { $('#aBotones').classList.add('oculto'); $('#aCerrar').classList.remove('oculto'); }
});
$('#aSonido').onclick = () => { Sirena.desbloquear(); setTimeout(() => { if (alertaEnPantalla) Sirena.iniciar(alertaEnPantalla.nivel); $('#aSonido').classList.toggle('oculto', Sirena.activa()); }, 150); };
$('#aCerrar').onclick = () => { Sirena.detener(); $('#alarma').classList.add('oculto'); };

// ---------- Activar avisos: sonido + notificaciones push ----------
function base64ToUint8(b64) {
  const p = '='.repeat((4 - b64.length % 4) % 4); const raw = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function activarPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'Este navegador no admite notificaciones push. En iPhone, agregue la app a la pantalla de inicio.';
  if (!token) return 'Sonido activado. Inscríbase abajo para recibir notificaciones con la app cerrada.';
  const permiso = await Notification.requestPermission();
  if (permiso !== 'granted') return 'Permiso de notificaciones denegado.';
  const reg = await navigator.serviceWorker.ready;
  const { key } = await (await fetch('/api/vapid')).json();
  const sub = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToUint8(key) });
  const r = await fetch('/api/suscribir', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ subscription: sub }) });
  return r.ok ? null : 'No se pudo registrar el teléfono.';
}
$('#btnActivar').onclick = async () => {
  Sirena.desbloquear(); // los navegadores exigen un toque del usuario para permitir sonido
  const err = await activarPush().catch(e => e.message);
  $('#btnActivar').classList.add('on'); $('#txtActivar').textContent = err ? 'Sonido activo' : 'Avisos activos';
  if (err) alert(err);
};

// ---------- Inscripción ----------
function cerrarSesion(msg) {
  localStorage.removeItem('tokenPersonal'); localStorage.removeItem('perfilPersonal');
  if (msg) alert(msg);
  location.reload();
}
function pintarPerfil() {
  if (!perfil || !perfil.unidad || typeof perfil.unidad !== 'object') return;
  $('#registro').classList.add('oculto'); $('#perfil').classList.remove('oculto');
  $('#subUnidad').textContent = perfil.unidad.sigla;
  $('#logoUnidad').src = perfil.unidad.escudo || '/logo.png'; $('#aEscudo').src = perfil.unidad.escudo || '/logo.png';
  $('#perfil').innerHTML = `<h3>Inscrito en la red</h3><div class="vacio">${esc(perfil.nombre)}</div>
    <div class="item" style="margin-top:10px;display:flex;gap:12px;align-items:center"><img src="${esc(perfil.unidad.escudo || '/logo.png')}" alt="" style="width:48px;height:48px;object-fit:contain">
      <div><div class="meta mono">UNIDAD</div><b>${esc(perfil.unidad.sigla)} · ${esc(perfil.unidad.nombre)}</b></div></div>
    <button class="btn" style="margin-top:12px;width:100%" id="btnSalir">Cerrar sesión en este teléfono</button>`;
  $('#btnSalir').onclick = () => { if (confirm('¿Dejar de recibir alertas en este teléfono?')) cerrarSesion(); };
  if (!datos.activas.length) mapa.setView([perfil.unidad.lat, perfil.unidad.lng], 13);
}
$('#btnRegistro').onclick = async () => {
  $('#rError').textContent = '';
  const r = await fetch('/api/registro', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre: $('#rNombre').value.trim(), codigo: $('#rCodigo').value.trim() }) });
  const d = await r.json();
  if (!r.ok) return $('#rError').textContent = d.error;
  token = d.token; perfil = d.perfil;
  localStorage.setItem('tokenPersonal', token); localStorage.setItem('perfilPersonal', JSON.stringify(perfil));
  socket.emit('unirse', token);
  pintarPerfil(); cargar(); $('#btnActivar').click();
};
// Inscripciones de la versión anterior (sin unidades) deben renovarse
if (token && (!perfil || typeof perfil.unidad !== 'object')) { localStorage.removeItem('tokenPersonal'); localStorage.removeItem('perfilPersonal'); token = null; perfil = null; }
pintarPerfil();
// Actualizar el perfil desde el servidor (por si cambió la unidad)
if (token) fetch('/api/perfil', { headers: { Authorization: 'Bearer ' + token } }).then(async r => {
  if (r.status === 401) return cerrarSesion('Su inscripción ya no es válida. Inscríbase de nuevo.');
  if (r.ok) { perfil = await r.json(); localStorage.setItem('perfilPersonal', JSON.stringify(perfil)); pintarPerfil(); }
});

function revisarSonido() {
  const abierta = !$('#alarma').classList.contains('oculto') && alertaEnPantalla && alertaEnPantalla.nivel !== 'DESPEJADO' && !$('#aBotones').classList.contains('oculto');
  $('#aSonido').classList.toggle('oculto', !abierta || Sirena.activa());
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  cargar();
  if (alertaEnPantalla && !$('#alarma').classList.contains('oculto') && !$('#aBotones').classList.contains('oculto')) Sirena.iniciar(alertaEnPantalla.nivel);
  setTimeout(revisarSonido, 400);
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
