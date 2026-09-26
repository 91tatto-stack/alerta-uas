// ===== Panel del Centro de Comando y Control =====
const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('tokenC2'); // sessionStorage: la sesión se cierra al cerrar la pestaña
let modo = 'SIMULACRO', nivel = null, zona = null, mapa, capa, marcador, circulo, socket;
const confirmaciones = {}; // alertaId -> resumen

const api = (url, opt = {}) => fetch(url, { ...opt, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opt.headers || {}) } })
  .then(async r => { if (r.status === 401) { salir(); throw new Error('Sesión vencida'); } const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });

// ---------- Login ----------
$('#btnLogin').onclick = async () => {
  $('#lError').textContent = '';
  const r = await fetch('/api/c2/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: $('#lUsuario').value.trim(), clave: $('#lClave').value }) });
  const d = await r.json();
  if (!r.ok) return $('#lError').textContent = d.error;
  token = d.token; sessionStorage.setItem('tokenC2', token); iniciar();
};
$('#lClave').onkeydown = e => { if (e.key === 'Enter') $('#btnLogin').click(); };
function salir() { sessionStorage.removeItem('tokenC2'); location.reload(); }

// ---------- Panel ----------
function iniciar() {
  $('#login').classList.add('oculto'); $('#panel').classList.remove('oculto');
  try { $('#quien').textContent = '· ' + JSON.parse(atob(token.split('.')[1])).usuario.toUpperCase(); } catch {}
  mapa = crearMapa('mapaC2'); capa = L.layerGroup().addTo(mapa);
  mapa.on('click', e => { zona = { lat: e.latlng.lat, lng: e.latlng.lng }; pintarSeleccion(); validar(); });
  $('#zRadio').oninput = () => { pintarSeleccion(); };

  socket = io();
  socket.on('connect', () => { socket.emit('c2:unirse', token); $('#conexion').textContent = 'EN LÍNEA'; $('#vivo').classList.remove('off'); refrescar(); });
  socket.on('disconnect', () => { $('#conexion').textContent = 'SIN CONEXIÓN'; $('#vivo').classList.add('off'); });
  socket.on('alerta:nueva', refrescar);
  socket.on('alerta:actualizada', refrescar);
  socket.on('confirmacion', d => { confirmaciones[d.alertaId] = d; pintarActivas(); });
  setInterval(refrescarStats, 15000);
}

function pintarSeleccion() {
  if (!zona) return;
  const radio = Number($('#zRadio').value) || 1000;
  const color = COLORES[nivel] || '#4ea1ff';
  if (marcador) mapa.removeLayer(marcador); if (circulo) mapa.removeLayer(circulo);
  marcador = L.circleMarker([zona.lat, zona.lng], { radius: 6, color: '#fff', fillColor: color, fillOpacity: 1 }).addTo(mapa);
  circulo = L.circle([zona.lat, zona.lng], { radius: radio, color, weight: 2, dashArray: '4 4', fillOpacity: .12 }).addTo(mapa);
}

// Modo
document.querySelectorAll('.modo button').forEach(b => b.onclick = () => {
  modo = b.dataset.m;
  document.querySelectorAll('.modo button').forEach(x => x.classList.toggle('sel', x === b));
  $('#bandera').className = 'bandera ' + modo;
  $('#bandera').textContent = modo === 'REAL' ? '⚠ MODO REAL · LAS ALERTAS ACTIVAN LA ALARMA DEL PERSONAL' : 'MODO SIMULACRO · las alertas se marcan como ejercicio';
  validar();
});
// Plantillas
document.querySelectorAll('.plantilla').forEach(b => b.onclick = () => {
  nivel = b.dataset.n;
  document.querySelectorAll('.plantilla').forEach(x => x.classList.toggle('sel', x === b));
  pintarSeleccion(); validar();
});

function validar() {
  const ok = !!(zona && nivel);
  const btn = $('#btnEnviar'); btn.disabled = !ok;
  btn.textContent = !ok ? 'Seleccione zona y tipo' : `Emitir ${modo === 'SIMULACRO' ? 'SIMULACRO' : 'ALERTA REAL'}`;
  btn.style.background = modo === 'REAL' ? 'var(--rojo)' : 'var(--azul)'; btn.style.color = '#fff';
}

// ---------- Emisión con confirmación ----------
$('#btnEnviar').onclick = () => {
  const nombres = { ATAQUE: 'ATAQUE EN CURSO', AMENAZA: 'AMENAZA DETECTADA', DESPEJADO: 'ZONA DESPEJADA' };
  $('#mTit').textContent = `${modo === 'REAL' ? '⚠ ALERTA REAL' : 'Simulacro'} · ${nombres[nivel]}`;
  $('#mTxt').textContent = `Zona: ${$('#zNombre').value || 'sin nombre'} · radio ${$('#zRadio').value} m. Se notificará a todo el personal inscrito.`;
  $('#mReal').classList.toggle('oculto', modo !== 'REAL'); $('#mConf').value = '';
  $('#modal').classList.remove('oculto'); (modo === 'REAL' ? $('#mConf') : $('#mOk')).focus();
};
$('#mCancelar').onclick = () => $('#modal').classList.add('oculto');
$('#mOk').onclick = async () => {
  if (modo === 'REAL' && $('#mConf').value.trim().toUpperCase() !== 'ENVIAR') return $('#mConf').focus();
  $('#modal').classList.add('oculto'); $('#eError').textContent = '';
  try {
    const d = await api('/api/c2/alertas', { method: 'POST', body: JSON.stringify({
      nivel, modo, mensaje: $('#mensaje').value.trim(), confirmacion: modo === 'REAL' ? 'ENVIAR' : undefined,
      zona: { ...zona, radio: Number($('#zRadio').value), nombre: $('#zNombre').value.trim() || 'Zona sin nombre' } }) });
    $('#eError').style.color = 'var(--verde)';
    $('#eError').textContent = `✓ Emitida ${fechaCorta(d.alerta.creada)} · push entregadas: ${d.push.enviadas}${d.push.fallidas ? ' · fallidas: ' + d.push.fallidas : ''}`;
    $('#mensaje').value = '';
  } catch (e) { $('#eError').style.color = ''; $('#eError').textContent = e.message; }
};

// ---------- Estado en vivo ----------
let activas = [];
async function refrescar() {
  const d = await fetch('/api/alertas').then(r => r.json());
  activas = d.activas;
  capa.clearLayers(); [...d.activas, ...d.historial.slice(0, 5)].forEach(a => dibujarZona(mapa, a, capa));
  await Promise.all(activas.map(async a => { confirmaciones[a.id] = await api(`/api/c2/alertas/${a.id}/confirmaciones`); }));
  pintarActivas(); refrescarStats();
}
async function refrescarStats() {
  try {
    const s = await api('/api/c2/resumen'); $('#sPersonal').textContent = s.personal; $('#sPush').textContent = s.suscripciones;
    const log = await api('/api/c2/auditoria');
    $('#log').innerHTML = log.map(l => `<div>${fechaCorta(l.fecha)} · <b>${esc(l.actor)}</b> · ${esc(l.accion)} · ${esc(l.detalle)}</div>`).join('') || 'Sin registros';
  } catch {}
}
function pintarActivas() {
  if (!activas.length) return $('#activas').innerHTML = '<div class="vacio">Sin alertas activas.</div>';
  $('#activas').innerHTML = activas.map(a => {
    const c = confirmaciones[a.id] || { cuenta: {}, lista: [] };
    const orden = { NECESITO_APOYO: 0, PENDIENTE: 1, RECIBIDO: 2, A_SALVO: 3 };
    const lista = [...c.lista].sort((x, y) => orden[x.estado] - orden[y.estado]);
    return `<div class="item" style="border-color:${COLORES[a.nivel]}">
      <div class="meta mono"><span class="punto ACTIVA"></span>${a.modo} · ${fechaCorta(a.creada)} · ${esc(a.zona.nombre)}</div>
      <b>${esc(a.titulo)}</b>
      <div class="stats">
        <div class="stat"><b style="color:var(--verde)">${c.cuenta.A_SALVO || 0}</b><span>A SALVO</span></div>
        <div class="stat"><b style="color:var(--azul)">${c.cuenta.RECIBIDO || 0}</b><span>RECIBIDO</span></div>
        <div class="stat"><b style="color:var(--rojo)">${c.cuenta.NECESITO_APOYO || 0}</b><span>APOYO</span></div>
        <div class="stat"><b style="color:var(--ambar)">${c.cuenta.PENDIENTE || 0}</b><span>SIN RESPUESTA</span></div>
      </div>
      <div style="margin-top:10px;max-height:180px;overflow:auto">${lista.map(p =>
        `<div class="persona"><span>${esc(p.nombre)} <span class="vacio">· ${esc(p.unidad)}</span></span><span class="tag ${p.estado}">${p.estado.replace('_', ' ')}</span></div>`).join('')}</div>
      <div class="acciones">
        <button class="btn" onclick="cerrar('${a.id}','RESUELTA')">Finalizar (resuelta)</button>
        <button class="btn" style="color:var(--ambar)" onclick="cerrar('${a.id}','FALSA_ALARMA')">Falsa alarma</button>
      </div></div>`;
  }).join('');
}
async function cerrar(id, estado) {
  if (estado === 'FALSA_ALARMA' && !confirm('¿Marcar como FALSA ALARMA? Se notificará la cancelación al personal.')) return;
  await api(`/api/c2/alertas/${id}/cerrar`, { method: 'POST', body: JSON.stringify({ estado }) });
}

if (token) iniciar();
