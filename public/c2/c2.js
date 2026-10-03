// ===== Panel del Centro de Comando y Control (multi-unidad) =====
const $ = s => document.querySelector(s);
let token = sessionStorage.getItem('tokenC2'); // sessionStorage: la sesión se cierra al cerrar la pestaña
let yo = null;            // perfil del operador { usuario, nombre, admin, unidad }
let unidades = [];        // unidades visibles para este operador
let destinos = new Set(); // unidades seleccionadas para la alerta
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
async function iniciar() {
  try { yo = await api('/api/c2/yo'); } catch { return; }
  $('#login').classList.add('oculto'); $('#panel').classList.remove('oculto');
  $('#quien').innerHTML = `· ${esc(yo.usuario.toUpperCase())} · ${yo.admin ? 'ADMINISTRADOR GENERAL' : esc(yo.unidad.sigla)} ${yo.admin ? '' : '· <a href="#" id="btnClave" style="color:var(--suave)">CAMBIAR CLAVE</a> '}· <a href="#" id="btnSalir" style="color:var(--suave)">SALIR</a>`;
  if ($('#btnClave')) $('#btnClave').onclick = e => { e.preventDefault(); ['#cActual', '#cNueva', '#cNueva2'].forEach(x => $(x).value = ''); $('#cError').textContent = ''; $('#mClave').classList.remove('oculto'); $('#cActual').focus(); };
  $('#btnSalir').onclick = e => { e.preventDefault(); salir(); };
  $('#admin').classList.toggle('oculto', !yo.admin);
  if (yo.unidad) $('#logoUnidad').src = yo.unidad.escudo;

  mapa = crearMapa('mapaC2'); capa = L.layerGroup().addTo(mapa);
  if (yo.unidad) mapa.setView([yo.unidad.lat, yo.unidad.lng], 13);
  mapa.on('click', e => { zona = { lat: e.latlng.lat, lng: e.latlng.lng }; pintarSeleccion(); validar(); });
  $('#zRadio').oninput = pintarSeleccion;

  await cargarUnidades();
  socket = io();
  socket.on('connect', () => { socket.emit('unirse', token); $('#conexion').textContent = 'EN LÍNEA'; $('#vivo').classList.remove('off'); refrescar(); });
  socket.on('disconnect', () => { $('#conexion').textContent = 'SIN CONEXIÓN'; $('#vivo').classList.add('off'); });
  socket.on('alerta:nueva', refrescar);
  socket.on('alerta:actualizada', refrescar);
  socket.on('confirmacion', async d => { try { confirmaciones[d.alertaId] = await api(`/api/c2/alertas/${d.alertaId}/confirmaciones`); pintarActivas(); } catch {} });
  setInterval(() => { cargarUnidades(); cargarBitacora(); cargarPersonal(); }, 20000);
  if (yo.admin) cargarOperadores();
}

// ---------- Cambio de contraseña ----------
$('#cCancelar').onclick = () => $('#mClave').classList.add('oculto');
$('#cOk').onclick = async () => {
  $('#cError').style.color = ''; $('#cError').textContent = '';
  if ($('#cNueva').value !== $('#cNueva2').value) return $('#cError').textContent = 'Las contraseñas nuevas no coinciden';
  try {
    await api('/api/c2/clave', { method: 'POST', body: JSON.stringify({ actual: $('#cActual').value, nueva: $('#cNueva').value }) });
    $('#cError').style.color = 'var(--verde)'; $('#cError').textContent = '✓ Contraseña actualizada';
    setTimeout(() => $('#mClave').classList.add('oculto'), 1200);
  } catch (e) { $('#cError').textContent = e.message; }
};

// ---------- Unidades ----------
async function cargarUnidades() {
  unidades = await api('/api/c2/unidades');
  if (!yo.admin) destinos = new Set(unidades.map(u => u.id));
  // Tarjetas con código y conteos
  $('#unidades').innerHTML = unidades.map(u => `
    <div class="unidad">
      <div style="display:flex;gap:12px;align-items:center"><img class="esc" src="${esc(u.escudo)}" alt="">
        <div><b>${esc(u.sigla)}</b> <small>${esc(u.nombre)}</small><br>
        <small>${u.personal} inscritos · ${u.push} con avisos push${u.operadores.length ? ' · CCOSD: ' + u.operadores.map(esc).join(', ') : ''}</small>
        ${yo.admin ? `<div class="acc"><a href="#" style="margin-left:0" onclick="editarUnidad('${u.id}');return false">editar</a><a href="#" onclick="elegirEscudo('${u.id}');return false">cambiar escudo</a>${u.escudo !== '/logo.png' ? `<a href="#" onclick="quitarEscudo('${u.id}');return false">quitar</a>` : ''}</div>` : ''}</div></div>
      <div style="text-align:right"><small>CÓDIGO</small><div class="cod">${esc(u.codigo)}</div>
        ${yo.admin ? `<a href="#" style="font-size:11px;color:var(--suave)" onclick="renovar('${u.id}');return false">renovar</a>` : ''}</div>
    </div>`).join('') || '<div class="vacio">Sin unidades.</div>';
  // Selector de destino
  if (yo.admin) {
    $('#destinos').innerHTML = `<label class="chip ${destinos.size === unidades.length && unidades.length ? 'sel' : ''}"><input type="checkbox" id="dTodas" ${destinos.size === unidades.length && unidades.length ? 'checked' : ''}> TODAS</label>` +
      unidades.map(u => `<label class="chip ${destinos.has(u.id) ? 'sel' : ''}"><input type="checkbox" data-u="${u.id}" ${destinos.has(u.id) ? 'checked' : ''}> ${esc(u.sigla)}</label>`).join('');
    $('#dTodas').onchange = e => { destinos = e.target.checked ? new Set(unidades.map(u => u.id)) : new Set(); cargarUnidadesUI(); };
    document.querySelectorAll('#destinos input[data-u]').forEach(i => i.onchange = () => { i.checked ? destinos.add(i.dataset.u) : destinos.delete(i.dataset.u); cargarUnidadesUI(); });
    $('#oUnidad').innerHTML = unidades.map(u => `<option value="${u.id}">${esc(u.sigla)}</option>`).join('');
  } else {
    $('#destinos').innerHTML = `<span class="chip sel">${esc(yo.unidad.sigla)}</span><span class="vacio" style="align-self:center">Solo puede alertar a su unidad</span>`;
  }
  validar();
}
function cargarUnidadesUI() { // redibuja sin volver a pedir datos
  document.querySelectorAll('#destinos input[data-u]').forEach(i => { i.checked = destinos.has(i.dataset.u); i.parentElement.classList.toggle('sel', i.checked); });
  const todas = destinos.size === unidades.length && unidades.length > 0;
  $('#dTodas').checked = todas; $('#dTodas').parentElement.classList.toggle('sel', todas);
  validar();
}
// ---------- Editar / eliminar unidad ----------
let editando = null;
function editarUnidad(id) {
  const u = unidades.find(x => x.id === id); if (!u) return; editando = u;
  $('#eNombre').value = u.nombre; $('#eSigla').value = u.sigla; $('#eMover').checked = false;
  $('#eMover').disabled = !zona; $('#eMoverTxt').textContent = zona ? 'Usar el punto marcado en el mapa como nueva ubicación' : 'Para cambiar la ubicación, primero toque el mapa';
  $('#eError').textContent = ''; $('#mUnidad').classList.remove('oculto'); $('#eNombre').focus();
}
$('#eCancelar').onclick = () => $('#mUnidad').classList.add('oculto');
$('#eOk').onclick = async () => {
  $('#eError').textContent = '';
  try {
    await api(`/api/c2/unidades/${editando.id}`, { method: 'PUT', body: JSON.stringify({ nombre: $('#eNombre').value, sigla: $('#eSigla').value, ubicacion: $('#eMover').checked ? zona : null }) });
    $('#mUnidad').classList.add('oculto'); cargarUnidades(); cargarPersonal(); cargarOperadores();
  } catch (e) { $('#eError').textContent = e.message; }
};
$('#eEliminar').onclick = async () => {
  if (!confirm(`¿Eliminar la unidad ${editando.sigla}? Esta acción no se puede deshacer.`)) return;
  try { await api(`/api/c2/unidades/${editando.id}`, { method: 'DELETE' }); destinos.delete(editando.id); $('#mUnidad').classList.add('oculto'); cargarUnidades(); cargarOperadores(); }
  catch (e) { $('#eError').textContent = e.message; }
};
async function renovar(id) {
  if (!confirm('¿Generar un código nuevo? El anterior dejará de servir para nuevas inscripciones (los ya inscritos no se afectan).')) return;
  await api(`/api/c2/unidades/${id}/codigo`, { method: 'POST' }); cargarUnidades();
}
$('#btnUnidad').onclick = async () => {
  $('#uError').textContent = '';
  const c = zona || mapa.getCenter();
  try {
    const u = await api('/api/c2/unidades', { method: 'POST', body: JSON.stringify({ nombre: $('#uNombre').value, sigla: $('#uSigla').value, lat: c.lat, lng: c.lng }) });
    $('#uNombre').value = ''; $('#uSigla').value = '';
    $('#uError').style.color = 'var(--verde)'; $('#uError').textContent = `✓ ${u.sigla} creada · código de inscripción: ${u.codigo}`;
    cargarUnidades();
  } catch (e) { $('#uError').style.color = ''; $('#uError').textContent = e.message; }
};

// ---------- Escudos (se reducen a 256 px en el navegador antes de subirlos) ----------
let escudoPara = null;
function elegirEscudo(id) { escudoPara = id; $('#fEscudo').value = ''; $('#fEscudo').click(); }
$('#fEscudo').onchange = async e => {
  const f = e.target.files[0]; if (!f || !escudoPara) return;
  try {
    const img = await new Promise((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => mal(new Error('No se pudo leer la imagen')); i.src = URL.createObjectURL(f); });
    const T = 256, c = document.createElement('canvas'); c.width = c.height = T;
    const k = Math.min(T / img.width, T / img.height), w = img.width * k, h = img.height * k;
    c.getContext('2d').drawImage(img, (T - w) / 2, (T - h) / 2, w, h); // mantiene la proporción y el fondo transparente
    await api(`/api/c2/unidades/${escudoPara}/escudo`, { method: 'POST', body: JSON.stringify({ imagen: c.toDataURL('image/png') }) });
    cargarUnidades();
  } catch (err) { alert(err.message); }
};
async function quitarEscudo(id) {
  if (!confirm('¿Quitar el escudo de esta unidad? Se mostrará el escudo general.')) return;
  await api(`/api/c2/unidades/${id}/escudo`, { method: 'DELETE' }); cargarUnidades();
}

// ---------- Operadores ----------
async function cargarOperadores() {
  const ops = await api('/api/c2/operadores');
  $('#operadores').innerHTML = ops.map(o => `<div class="persona"><span>${esc(o.usuario)} <span class="vacio">· ${esc(o.nombre)}</span><br>
      ${o.principal ? '<span class="vacio" style="font-size:11px">Administrador principal (clave en Render)</span>'
        : `<a href="#" class="lnk" onclick="claveOperador('${o.id}','${esc(o.usuario)}');return false">cambiar clave</a> <a href="#" class="lnk rojo" onclick="eliminarOperador('${o.id}','${esc(o.usuario)}');return false">eliminar</a>`}</span>
      <span class="tag">${esc(o.unidad)}</span></div>`).join('');
}
$('#btnOperador').onclick = async () => {
  $('#oError').textContent = '';
  try {
    await api('/api/c2/operadores', { method: 'POST', body: JSON.stringify({ usuario: $('#oUsuario').value, nombre: $('#oNombre').value, clave: $('#oClave').value, unidadId: $('#oUnidad').value }) });
    $('#oError').style.color = 'var(--verde)'; $('#oError').textContent = `✓ Operador ${$('#oUsuario').value} creado`;
    $('#oUsuario').value = $('#oNombre').value = $('#oClave').value = '';
    cargarOperadores(); cargarUnidades();
  } catch (e) { $('#oError').style.color = ''; $('#oError').textContent = e.message; }
};

async function claveOperador(id, usuario) {
  const c = prompt(`Nueva contraseña para ${usuario} (mínimo 10 caracteres):`);
  if (c === null) return;
  try { await api(`/api/c2/operadores/${id}/clave`, { method: 'POST', body: JSON.stringify({ clave: c }) }); alert(`✓ Contraseña de ${usuario} actualizada. Sus sesiones abiertas se cerraron.`); }
  catch (e) { alert(e.message); }
}
async function eliminarOperador(id, usuario) {
  if (!confirm(`¿Eliminar al operador ${usuario}? Ya no podrá ingresar.`)) return;
  try { await api(`/api/c2/operadores/${id}`, { method: 'DELETE' }); cargarOperadores(); cargarUnidades(); } catch (e) { alert(e.message); }
}

// ---------- Personal inscrito ----------
let personal = [];
async function cargarPersonal() {
  try { personal = await api('/api/c2/personal'); pintarPersonal(); } catch {}
}
function pintarPersonal() {
  const q = $('#pBuscar').value.trim().toLowerCase();
  const lista = personal.filter(p => !q || p.nombre.toLowerCase().includes(q) || (p.unidad || '').toLowerCase().includes(q));
  $('#personal').innerHTML = lista.map(p => `<div class="persona"><span>${esc(p.nombre)} <span class="vacio">· ${esc(p.unidad)} ${p.push ? '· push ✓' : '· sin push'}</span></span>
    <a href="#" class="lnk rojo" onclick="eliminarPersonal('${p.id}');return false">dar de baja</a></div>`).join('')
    || `<div class="vacio">${personal.length ? 'Sin resultados.' : 'Nadie inscrito todavía.'}</div>`;
}
$('#pBuscar').oninput = pintarPersonal;
async function eliminarPersonal(id) {
  const p = personal.find(x => x.id === id); if (!p) return;
  if (!confirm(`¿Dar de baja a ${p.nombre} (${p.unidad})? Su teléfono dejará de recibir alertas.`)) return;
  try { await api(`/api/c2/personal/${id}`, { method: 'DELETE' }); cargarPersonal(); cargarUnidades(); } catch (e) { alert(e.message); }
}

// ---------- Zona ----------
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
  const falta = !destinos.size ? 'Seleccione unidades destino' : !zona ? 'Toque el mapa para ubicar la zona' : !nivel ? 'Seleccione el tipo de alerta' : null;
  const btn = $('#btnEnviar'); btn.disabled = !!falta;
  btn.textContent = falta || `Emitir ${modo === 'SIMULACRO' ? 'SIMULACRO' : 'ALERTA REAL'} · ${nombresDestino()}`;
  btn.style.background = modo === 'REAL' ? 'var(--rojo)' : 'var(--azul)'; btn.style.color = '#fff';
}
function nombresDestino() {
  if (yo && yo.admin && destinos.size === unidades.length && unidades.length > 1) return 'TODAS LAS UNIDADES';
  return unidades.filter(u => destinos.has(u.id)).map(u => u.sigla).join(', ');
}

// ---------- Emisión con confirmación ----------
$('#btnEnviar').onclick = () => {
  const nombres = { ATAQUE: 'ATAQUE EN CURSO', AMENAZA: 'AMENAZA DETECTADA', DESPEJADO: 'ZONA DESPEJADA' };
  const personas = unidades.filter(u => destinos.has(u.id)).reduce((n, u) => n + u.personal, 0);
  $('#mTit').textContent = `${modo === 'REAL' ? '⚠ ALERTA REAL' : 'Simulacro'} · ${nombres[nivel]}`;
  $('#mTxt').innerHTML = `Destino: <b>${esc(nombresDestino())}</b> (${personas} personas inscritas).<br>Zona: ${esc($('#zNombre').value || 'sin nombre')} · radio ${esc($('#zRadio').value)} m.`;
  $('#mReal').classList.toggle('oculto', modo !== 'REAL'); $('#mConf').value = '';
  $('#modal').classList.remove('oculto'); (modo === 'REAL' ? $('#mConf') : $('#mOk')).focus();
};
$('#mCancelar').onclick = () => $('#modal').classList.add('oculto');
$('#mOk').onclick = async () => {
  if (modo === 'REAL' && $('#mConf').value.trim().toUpperCase() !== 'ENVIAR') return $('#mConf').focus();
  $('#modal').classList.add('oculto'); $('#eError').textContent = '';
  try {
    const d = await api('/api/c2/alertas', { method: 'POST', body: JSON.stringify({
      nivel, modo, unidades: [...destinos], mensaje: $('#mensaje').value.trim(), confirmacion: modo === 'REAL' ? 'ENVIAR' : undefined,
      zona: { ...zona, radio: Number($('#zRadio').value), nombre: $('#zNombre').value.trim() || 'Zona sin nombre' } }) });
    $('#eError').style.color = 'var(--verde)';
    $('#eError').textContent = `✓ Emitida ${fechaCorta(d.alerta.creada)} a ${d.alerta.siglas} · push entregadas: ${d.push.enviadas}${d.push.fallidas ? ' · fallidas: ' + d.push.fallidas : ''}`;
    $('#mensaje').value = '';
  } catch (e) { $('#eError').style.color = ''; $('#eError').textContent = e.message; }
};

// ---------- Estado en vivo ----------
let activas = [];
async function refrescar() {
  const d = await api('/api/c2/alertas');
  activas = d.activas;
  capa.clearLayers(); [...d.activas, ...d.historial.slice(0, 5)].forEach(a => dibujarZona(mapa, a, capa));
  await Promise.all(activas.map(async a => { confirmaciones[a.id] = await api(`/api/c2/alertas/${a.id}/confirmaciones`); }));
  pintarActivas(); cargarBitacora(); cargarUnidades(); cargarPersonal();
}
async function cargarBitacora() {
  try {
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
    const puedeCerrar = yo.admin || a.unidades.every(id => yo.unidad && id === yo.unidad.id);
    return `<div class="item" style="border-color:${COLORES[a.nivel]}">
      <div class="meta mono"><span class="punto ACTIVA"></span>${a.modo} · ${fechaCorta(a.creada)} · ${esc(a.siglas)} · ${esc(a.zona.nombre)}</div>
      <b>${esc(a.titulo)}</b>
      <div class="stats">
        <div class="stat"><b style="color:var(--verde)">${c.cuenta.A_SALVO || 0}</b><span>A SALVO</span></div>
        <div class="stat"><b style="color:var(--azul)">${c.cuenta.RECIBIDO || 0}</b><span>RECIBIDO</span></div>
        <div class="stat"><b style="color:var(--rojo)">${c.cuenta.NECESITO_APOYO || 0}</b><span>APOYO</span></div>
        <div class="stat"><b style="color:var(--ambar)">${c.cuenta.PENDIENTE || 0}</b><span>SIN RESPUESTA</span></div>
      </div>
      <div style="margin-top:10px;max-height:200px;overflow:auto">${lista.map(p =>
        `<div class="persona"><span>${esc(p.nombre)} <span class="vacio">· ${esc(p.unidad)}</span></span><span class="tag ${p.estado}">${p.estado.replace('_', ' ')}</span></div>`).join('')}</div>
      ${puedeCerrar ? `<div class="acciones">
        <button class="btn" onclick="cerrar('${a.id}','RESUELTA')">Finalizar (resuelta)</button>
        <button class="btn" style="color:var(--ambar)" onclick="cerrar('${a.id}','FALSA_ALARMA')">Falsa alarma</button>
      </div>` : '<div class="aviso">Alerta de varias unidades: la finaliza el administrador general.</div>'}</div>`;
  }).join('');
}
async function cerrar(id, estado) {
  if (estado === 'FALSA_ALARMA' && !confirm('¿Marcar como FALSA ALARMA? Se notificará la cancelación al personal.')) return;
  try { await api(`/api/c2/alertas/${id}/cerrar`, { method: 'POST', body: JSON.stringify({ estado }) }); } catch (e) { alert(e.message); }
}

if (token) iniciar();
