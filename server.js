// ============================================================
//  ALERTA UAS - Prototipo Fase 1 (multi-unidad)
//  Backend: Express + Socket.IO + Web Push
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webpush = require('web-push');
const { Server } = require('socket.io');

// ---------- Configuración (usar variables de entorno en producción) ----------
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CODIGO_UNIDAD = process.env.CODIGO_UNIDAD || 'FAC2026'; // código de la unidad inicial de prueba
const CONTACTO_VAPID = process.env.VAPID_CONTACT || 'mailto:admin@example.com';

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');
const ESCUDOS_DIR = path.join(DATA_DIR, 'escudos');
fs.mkdirSync(ESCUDOS_DIR, { recursive: true });

// ---------- Secretos: se generan la primera vez y se guardan ----------
function cargarSecretos() {
  if (fs.existsSync(SECRETS_FILE)) return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  const vapid = webpush.generateVAPIDKeys();
  const s = { jwtSecret: crypto.randomBytes(48).toString('hex'), vapidPublic: vapid.publicKey, vapidPrivate: vapid.privateKey };
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2));
  return s;
}
const SECRETS = cargarSecretos();
const JWT_SECRET = process.env.JWT_SECRET || SECRETS.jwtSecret;
webpush.setVapidDetails(CONTACTO_VAPID, process.env.VAPID_PUBLIC || SECRETS.vapidPublic, process.env.VAPID_PRIVATE || SECRETS.vapidPrivate);

// ---------- Base de datos simple en archivo JSON (reemplazar por PostgreSQL en Fase 2) ----------
function nuevoCodigo() { // 6 caracteres sin letras/números confusos (0/O, 1/I)
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c; do { c = Array.from(crypto.randomBytes(6), b => abc[b % abc.length]).join(''); } while (db && db.unidades.some(u => u.codigo === c));
  return c;
}
function cargarDB() {
  if (fs.existsSync(DB_FILE)) {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!d.unidades) { // migración desde la versión sin unidades
      d.unidades = [{ id: 'u-1', nombre: 'Unidad de prueba', sigla: 'PRUEBA', codigo: CODIGO_UNIDAD, lat: 4.65, lng: -74.1 }];
      d.operadores.forEach(o => { o.rol = o.rol || 'admin'; o.unidadId = o.unidadId || null; });
      d.personal.forEach(p => { p.unidadId = 'u-1'; });
      d.alertas.forEach(a => { a.unidades = a.unidades || ['u-1']; });
    }
    return d;
  }
  return {
    unidades: [
      // Unidad inicial de prueba. Las demás las crea el administrador desde el C2.
      { id: 'u-1', nombre: 'Unidad de prueba', sigla: 'PRUEBA', codigo: CODIGO_UNIDAD, lat: 4.65, lng: -74.1 }
    ],
    operadores: [
      // Administrador general. CAMBIAR la contraseña antes de cualquier uso real (variable C2_PASSWORD).
      { id: 'op-1', usuario: 'tatto91', nombre: 'Administrador YO', rol: 'admin', unidadId: null, hash: bcrypt.hashSync(process.env.C2_PASSWORD || 'julianT27*', 10) }
    ],
    personal: [],       // { id, nombre, unidadId, creado }
    suscripciones: [],  // { personalId, sub }
    alertas: [],        // { id, nivel, modo, unidades:[ids], zona, ... }
    confirmaciones: [], // { alertaId, personalId, estado, fecha }
    auditoria: []       // { fecha, actor, accion, detalle, unidades:[ids] }
  };
}
let db = null;
db = cargarDB();
let guardando = null;
function guardar() {
  clearTimeout(guardando);
  guardando = setTimeout(() => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)), 100);
}
guardar();
function auditar(actor, accion, detalle, unidades = []) {
  db.auditoria.unshift({ fecha: new Date().toISOString(), actor, accion, detalle, unidades });
  db.auditoria = db.auditoria.slice(0, 2000);
  guardar();
}
const unidad = id => db.unidades.find(u => u.id === id);
const siglas = ids => ids.map(id => (unidad(id) || {}).sigla || '?').join(', ');

// ---------- Catálogo de niveles (deben coincidir con los protocolos / ROE C-UAS) ----------
const NIVELES = {
  ATAQUE:    { titulo: 'ATAQUE CON DRON EN CURSO', instruccion: 'Busque refugio inmediato. Aléjese de ventanas y espacios abiertos. Espere instrucciones.' },
  AMENAZA:   { titulo: 'AMENAZA UAS DETECTADA',    instruccion: 'Esté alerta. Diríjase a la zona de refugio más cercana y mantenga el teléfono a mano.' },
  DESPEJADO: { titulo: 'ZONA DESPEJADA',           instruccion: 'La amenaza ha terminado. Retome actividades siguiendo las órdenes de su superior.' }
};
const ESTADOS_CONFIRMACION = ['RECIBIDO', 'A_SALVO', 'NECESITO_APOYO'];

// ---------- App ----------
const app = express();
app.set('trust proxy', 1); // detrás de Render/Railway/Nginx, para que el limitador vea la IP real
const jsonPequeno = express.json({ limit: '50kb' }), jsonEscudo = express.json({ limit: '1mb' });
app.use((req, res, next) => (req.path.endsWith('/escudo') ? jsonEscudo : jsonPequeno)(req, res, next));
app.use((req, res, next) => { // cabeceras básicas de seguridad
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));
app.get('/c2', (req, res) => res.sendFile(path.join(__dirname, 'public', 'c2', 'index.html')));

const server = http.createServer(app);
const io = new Server(server);

// ---------- Autenticación y permisos ----------
function firmar(payload, horas) { return jwt.sign(payload, JWT_SECRET, { expiresIn: `${horas}h` }); }
function auth(rol) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    try {
      const data = jwt.verify(token, JWT_SECRET);
      if (rol && data.rol !== rol) return res.status(403).json({ error: 'Sin permiso' });
      if (data.rol === 'personal') { // el personal debe seguir existiendo en la base
        const p = db.personal.find(x => x.id === data.id);
        if (!p) return res.status(401).json({ error: 'Inscripción no encontrada. Inscríbase de nuevo.' });
        req.personal = p;
      }
      if (data.rol === 'c2') {
        const op = db.operadores.find(x => x.id === data.id);
        if (!op) return res.status(401).json({ error: 'Operador no existe' });
        req.op = op;
      }
      req.user = data; next();
    } catch { res.status(401).json({ error: 'Sesión inválida o vencida' }); }
  };
}
const esAdmin = op => op.rol === 'admin';
const soloAdmin = (req, res, next) => esAdmin(req.op) ? next() : res.status(403).json({ error: 'Solo el administrador general' });
// Unidades que un operador puede ver/alertar
const unidadesDe = op => esAdmin(op) ? db.unidades.map(u => u.id) : [op.unidadId];
const puedeVer = (op, alerta) => esAdmin(op) || alerta.unidades.includes(op.unidadId);

// Limitador simple de intentos de login (anti fuerza bruta)
const intentos = new Map();
function limitar(max) {
  return (req, res, next) => {
    const k = req.path + req.ip; const now = Date.now();
    const r = (intentos.get(k) || []).filter(t => now - t < 15 * 60 * 1000);
    if (r.length >= max) return res.status(429).json({ error: 'Demasiados intentos. Espere 15 minutos.' });
    r.push(now); intentos.set(k, r); next();
  };
}

app.post('/api/c2/login', limitar(5), (req, res) => {
  const { usuario, clave } = req.body || {};
  const op = db.operadores.find(o => o.usuario === String(usuario || '').toLowerCase());
  if (!op || !bcrypt.compareSync(String(clave || ''), op.hash)) {
    auditar(String(usuario || '?'), 'LOGIN_FALLIDO', 'Intento de acceso al C2');
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  auditar(op.usuario, 'LOGIN', 'Ingreso al C2', op.unidadId ? [op.unidadId] : []);
  res.json({ token: firmar({ id: op.id, usuario: op.usuario, rol: 'c2' }, 12), perfil: perfilOperador(op) });
});
function perfilOperador(op) {
  return { usuario: op.usuario, nombre: op.nombre, admin: esAdmin(op), unidad: op.unidadId ? unidad(op.unidadId) && publicaUnidad(unidad(op.unidadId)) : null };
}
const publicaUnidad = u => ({ id: u.id, nombre: u.nombre, sigla: u.sigla, lat: u.lat, lng: u.lng, escudo: u.escudoV ? `/api/escudo/${u.id}?v=${u.escudoV}` : '/logo.png' });
app.get('/api/c2/yo', auth('c2'), (req, res) => res.json(perfilOperador(req.op)));

// ---------- Inscripción del personal: el código define la unidad ----------
app.post('/api/registro', limitar(20), (req, res) => {
  const { nombre, codigo } = req.body || {};
  const u = db.unidades.find(x => x.codigo === String(codigo || '').trim().toUpperCase());
  if (!u) return res.status(403).json({ error: 'Código de unidad incorrecto' });
  if (!nombre || String(nombre).trim().length < 3) return res.status(400).json({ error: 'Escriba su grado y nombre' });
  const p = { id: 'p-' + crypto.randomUUID(), nombre: String(nombre).trim().slice(0, 80), unidadId: u.id, creado: new Date().toISOString() };
  db.personal.push(p); guardar();
  auditar(p.nombre, 'REGISTRO', `Personal inscrito en ${u.sigla}`, [u.id]);
  res.json({ token: firmar({ id: p.id, rol: 'personal' }, 24 * 180), perfil: { nombre: p.nombre, unidad: publicaUnidad(u) } });
});
app.get('/api/perfil', auth('personal'), (req, res) => {
  const u = unidad(req.personal.unidadId);
  res.json({ nombre: req.personal.nombre, unidad: u ? publicaUnidad(u) : null });
});

// ---------- Web Push ----------
app.get('/api/vapid', (req, res) => res.json({ key: process.env.VAPID_PUBLIC || SECRETS.vapidPublic }));
app.post('/api/suscribir', auth('personal'), (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
  db.suscripciones = db.suscripciones.filter(s => s.sub.endpoint !== sub.endpoint);
  db.suscripciones.push({ personalId: req.personal.id, sub }); guardar();
  res.json({ ok: true });
});

async function enviarPush(alerta) {
  // Solo al personal de las unidades destino.
  // OPSEC: la notificación NO lleva detalles (pasa por servidores de Google/Apple/Mozilla).
  const destino = new Set(db.personal.filter(p => alerta.unidades.includes(p.unidadId)).map(p => p.id));
  const subs = db.suscripciones.filter(s => destino.has(s.personalId));
  const payload = JSON.stringify({
    title: alerta.modo === 'SIMULACRO' ? 'SIMULACRO – Alerta UAS' : 'ALERTA – Abra la aplicación',
    body: 'Hay una alerta activa. Abra la app para ver instrucciones.',
    tag: 'alerta-' + alerta.id
  });
  const res = await Promise.allSettled(subs.map(s =>
    webpush.sendNotification(s.sub, payload, { TTL: 300, urgency: 'high' }).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) s.vencida = true; // suscripción caducada
      throw err;
    })
  ));
  db.suscripciones = db.suscripciones.filter(s => !s.vencida); guardar();
  return { enviadas: res.filter(r => r.status === 'fulfilled').length, fallidas: res.filter(r => r.status === 'rejected').length };
}

// ---------- Alertas ----------
function alertaPublica(a) {
  return { id: a.id, nivel: a.nivel, modo: a.modo, titulo: a.titulo, instruccion: a.instruccion, mensaje: a.mensaje,
           zona: a.zona, estado: a.estado, creada: a.creada, cerrada: a.cerrada, unidades: a.unidades, siglas: siglas(a.unidades) };
}
function resumenConfirmaciones(alerta, op) {
  const visibles = new Set(unidadesDe(op).filter(id => alerta.unidades.includes(id)));
  const conf = db.confirmaciones.filter(c => c.alertaId === alerta.id);
  const lista = db.personal.filter(p => visibles.has(p.unidadId)).map(p => {
    const c = conf.find(x => x.personalId === p.id);
    return { id: p.id, nombre: p.nombre, unidad: (unidad(p.unidadId) || {}).sigla, estado: c ? c.estado : 'PENDIENTE', fecha: c ? c.fecha : null };
  });
  const cuenta = { RECIBIDO: 0, A_SALVO: 0, NECESITO_APOYO: 0, PENDIENTE: 0 };
  lista.forEach(l => cuenta[l.estado]++);
  return { cuenta, lista };
}
// Notificar en tiempo real solo a quien corresponde
function emitirAlerta(evento, a) {
  const pub = alertaPublica(a);
  a.unidades.forEach(id => { io.to('u:' + id).emit(evento, pub); io.to('c2:' + id).emit(evento, pub); });
  io.to('c2:admin').emit(evento, pub);
}

// Personal: solo alertas de su unidad
app.get('/api/alertas', auth('personal'), (req, res) => {
  const mias = db.alertas.filter(a => a.unidades.includes(req.personal.unidadId));
  res.json({
    activas: mias.filter(a => a.estado === 'ACTIVA').map(alertaPublica),
    historial: mias.filter(a => a.estado !== 'ACTIVA').slice(0, 30).map(alertaPublica)
  });
});
// C2: alertas de las unidades a su cargo
app.get('/api/c2/alertas', auth('c2'), (req, res) => {
  const vis = db.alertas.filter(a => puedeVer(req.op, a));
  res.json({ activas: vis.filter(a => a.estado === 'ACTIVA').map(alertaPublica), historial: vis.filter(a => a.estado !== 'ACTIVA').slice(0, 30).map(alertaPublica) });
});

app.post('/api/c2/alertas', auth('c2'), async (req, res) => {
  const { nivel, modo, zona, mensaje, confirmacion } = req.body || {};
  if (!NIVELES[nivel]) return res.status(400).json({ error: 'Nivel inválido' });
  if (!['REAL', 'SIMULACRO'].includes(modo)) return res.status(400).json({ error: 'Modo inválido' });
  if (!zona || typeof zona.lat !== 'number' || typeof zona.lng !== 'number') return res.status(400).json({ error: 'Seleccione la zona en el mapa' });
  // Un operador de unidad solo puede alertar a su unidad; el admin elige
  const permitidas = unidadesDe(req.op);
  const unidades = esAdmin(req.op) ? [...new Set((req.body.unidades || []))].filter(id => permitidas.includes(id)) : [req.op.unidadId];
  if (!unidades.length) return res.status(400).json({ error: 'Seleccione al menos una unidad destino' });
  // Salvaguarda anti-error (lección Hawái 2018): una alerta REAL exige escribir la palabra de confirmación
  if (modo === 'REAL' && confirmacion !== 'ENVIAR') return res.status(400).json({ error: 'Confirmación requerida para alerta REAL' });

  const a = {
    id: crypto.randomUUID().slice(0, 8), nivel, modo, unidades,
    titulo: (modo === 'SIMULACRO' ? 'SIMULACRO · ' : '') + NIVELES[nivel].titulo,
    instruccion: NIVELES[nivel].instruccion,
    mensaje: String(mensaje || '').slice(0, 280),
    zona: { lat: zona.lat, lng: zona.lng, radio: Math.min(Math.max(Number(zona.radio) || 1000, 100), 50000), nombre: String(zona.nombre || 'Zona').slice(0, 60) },
    estado: 'ACTIVA', creada: new Date().toISOString(), cerrada: null, enviadaPor: req.op.usuario
  };
  // "Zona despejada" cierra las alertas activas de esas mismas unidades
  if (nivel === 'DESPEJADO') {
    db.alertas.filter(x => x.estado === 'ACTIVA' && x.unidades.every(id => unidades.includes(id))).forEach(x => {
      x.estado = 'RESUELTA'; x.cerrada = a.creada; emitirAlerta('alerta:actualizada', x);
    });
  }
  db.alertas.unshift(a); guardar();
  emitirAlerta('alerta:nueva', a);
  const push = await enviarPush(a);
  auditar(req.op.usuario, 'ALERTA_ENVIADA', `${a.modo} · ${a.nivel} · ${siglas(unidades)} · ${a.zona.nombre} · push ok=${push.enviadas} fallo=${push.fallidas}`, unidades);
  res.json({ alerta: alertaPublica(a), push });
});

app.post('/api/c2/alertas/:id/cerrar', auth('c2'), (req, res) => {
  const a = db.alertas.find(x => x.id === req.params.id);
  if (!a || a.estado !== 'ACTIVA') return res.status(404).json({ error: 'Alerta no activa' });
  // Un operador solo cierra alertas que afectan únicamente a su unidad
  if (!esAdmin(req.op) && a.unidades.some(id => id !== req.op.unidadId)) return res.status(403).json({ error: 'Esta alerta involucra otras unidades: la cierra el administrador' });
  const estado = req.body && req.body.estado === 'FALSA_ALARMA' ? 'FALSA_ALARMA' : 'RESUELTA';
  a.estado = estado; a.cerrada = new Date().toISOString(); guardar();
  emitirAlerta('alerta:actualizada', a);
  auditar(req.op.usuario, estado === 'FALSA_ALARMA' ? 'FALSA_ALARMA' : 'ALERTA_CERRADA', `${a.id} · ${a.titulo} · ${siglas(a.unidades)}`, a.unidades);
  res.json({ ok: true });
});

app.get('/api/c2/alertas/:id/confirmaciones', auth('c2'), (req, res) => {
  const a = db.alertas.find(x => x.id === req.params.id);
  if (!a || !puedeVer(req.op, a)) return res.status(404).json({ error: 'No encontrada' });
  res.json(resumenConfirmaciones(a, req.op));
});
app.get('/api/c2/auditoria', auth('c2'), (req, res) => {
  const log = esAdmin(req.op) ? db.auditoria : db.auditoria.filter(l => (l.unidades || []).includes(req.op.unidadId));
  res.json(log.slice(0, 100));
});

// ---------- Unidades (admin crea; operadores ven la suya) ----------
function resumenUnidad(u, conCodigo) {
  const ids = new Set(db.personal.filter(p => p.unidadId === u.id).map(p => p.id));
  return { ...publicaUnidad(u), codigo: conCodigo ? u.codigo : undefined, personal: ids.size,
           push: new Set(db.suscripciones.filter(s => ids.has(s.personalId)).map(s => s.personalId)).size,
           operadores: db.operadores.filter(o => o.unidadId === u.id).map(o => o.usuario) };
}
app.get('/api/c2/unidades', auth('c2'), (req, res) => {
  res.json(db.unidades.filter(u => unidadesDe(req.op).includes(u.id)).map(u => resumenUnidad(u, true)));
});
app.post('/api/c2/unidades', auth('c2'), soloAdmin, (req, res) => {
  const { nombre, sigla, lat, lng } = req.body || {};
  if (!nombre || !sigla) return res.status(400).json({ error: 'Nombre y sigla son obligatorios' });
  if (db.unidades.some(u => u.sigla.toUpperCase() === String(sigla).trim().toUpperCase())) return res.status(400).json({ error: 'Ya existe una unidad con esa sigla' });
  const u = { id: 'u-' + crypto.randomUUID().slice(0, 8), nombre: String(nombre).trim().slice(0, 80), sigla: String(sigla).trim().toUpperCase().slice(0, 20),
              codigo: nuevoCodigo(), lat: Number(lat) || 4.65, lng: Number(lng) || -74.1 };
  db.unidades.push(u); guardar();
  auditar(req.op.usuario, 'UNIDAD_CREADA', `${u.sigla} · ${u.nombre}`, [u.id]);
  res.json(resumenUnidad(u, true));
});
app.post('/api/c2/unidades/:id/codigo', auth('c2'), soloAdmin, (req, res) => { // por si el código se filtra
  const u = unidad(req.params.id); if (!u) return res.status(404).json({ error: 'No existe' });
  u.codigo = nuevoCodigo(); guardar();
  auditar(req.op.usuario, 'CODIGO_RENOVADO', u.sigla, [u.id]);
  res.json(resumenUnidad(u, true));
});

// ---------- Escudo de cada unidad ----------
// El C2 lo redimensiona a 256 px antes de enviarlo; aquí se valida que sea una imagen PNG/JPEG/WEBP real.
app.post('/api/c2/unidades/:id/escudo', auth('c2'), soloAdmin, (req, res) => {
  const u = unidad(req.params.id); if (!u) return res.status(404).json({ error: 'No existe' });
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec((req.body && req.body.imagen) || '');
  if (!m) return res.status(400).json({ error: 'Formato no válido (use PNG, JPG o WEBP)' });
  const buf = Buffer.from(m[2], 'base64');
  const firma = buf.slice(0, 12).toString('hex');
  const valida = firma.startsWith('89504e47') || firma.startsWith('ffd8ff') || (firma.startsWith('52494646') && buf.slice(8, 12).toString() === 'WEBP');
  if (!valida || buf.length > 700 * 1024) return res.status(400).json({ error: 'Imagen no válida o demasiado grande' });
  fs.writeFileSync(path.join(ESCUDOS_DIR, u.id + '.img'), buf);
  u.escudoV = Date.now(); u.escudoTipo = 'image/' + m[1]; guardar();
  auditar(req.op.usuario, 'ESCUDO_ACTUALIZADO', u.sigla, [u.id]);
  res.json(resumenUnidad(u, true));
});
app.delete('/api/c2/unidades/:id/escudo', auth('c2'), soloAdmin, (req, res) => {
  const u = unidad(req.params.id); if (!u) return res.status(404).json({ error: 'No existe' });
  try { fs.unlinkSync(path.join(ESCUDOS_DIR, u.id + '.img')); } catch {}
  delete u.escudoV; delete u.escudoTipo; guardar();
  auditar(req.op.usuario, 'ESCUDO_ELIMINADO', u.sigla, [u.id]);
  res.json(resumenUnidad(u, true));
});
app.get('/api/escudo/:id', (req, res) => {
  const u = unidad(req.params.id), f = u && path.join(ESCUDOS_DIR, u.id + '.img');
  if (!u || !u.escudoV || !fs.existsSync(f)) return res.redirect('/logo.png');
  res.setHeader('Content-Type', u.escudoTipo || 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(f);
});

// ---------- Operadores (solo admin) ----------
app.get('/api/c2/operadores', auth('c2'), soloAdmin, (req, res) => {
  res.json(db.operadores.map(o => ({ usuario: o.usuario, nombre: o.nombre, rol: o.rol, unidad: o.unidadId ? (unidad(o.unidadId) || {}).sigla : 'TODAS' })));
});
app.post('/api/c2/operadores', auth('c2'), soloAdmin, (req, res) => {
  const { usuario, nombre, clave, unidadId } = req.body || {};
  const user = String(usuario || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(user)) return res.status(400).json({ error: 'Usuario: 3 a 30 caracteres (letras, números, punto o guion)' });
  if (db.operadores.some(o => o.usuario === user)) return res.status(400).json({ error: 'Ese usuario ya existe' });
  if (String(clave || '').length < 10) return res.status(400).json({ error: 'La contraseña debe tener al menos 10 caracteres' });
  if (!unidad(unidadId)) return res.status(400).json({ error: 'Seleccione la unidad del operador' });
  const op = { id: 'op-' + crypto.randomUUID().slice(0, 8), usuario: user, nombre: String(nombre || user).slice(0, 80), rol: 'operador', unidadId, hash: bcrypt.hashSync(String(clave), 10) };
  db.operadores.push(op); guardar();
  auditar(req.op.usuario, 'OPERADOR_CREADO', `${op.usuario} → ${unidad(unidadId).sigla}`, [unidadId]);
  res.json({ ok: true });
});

// ---------- Confirmación del personal ----------
app.post('/api/alertas/:id/confirmar', auth('personal'), (req, res) => {
  const a = db.alertas.find(x => x.id === req.params.id);
  const estado = req.body && req.body.estado;
  if (!a || !a.unidades.includes(req.personal.unidadId)) return res.status(404).json({ error: 'Alerta no existe' });
  if (!ESTADOS_CONFIRMACION.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  db.confirmaciones = db.confirmaciones.filter(c => !(c.alertaId === a.id && c.personalId === req.personal.id));
  db.confirmaciones.push({ alertaId: a.id, personalId: req.personal.id, estado, fecha: new Date().toISOString() }); guardar();
  // El C2 vuelve a consultar el resumen (cada operador ve solo su unidad)
  io.to('c2:admin').to('c2:' + req.personal.unidadId).emit('confirmacion', { alertaId: a.id });
  res.json({ ok: true });
});

// ---------- Tiempo real: cada conexión entra a la "sala" de su unidad ----------
io.on('connection', socket => {
  socket.on('unirse', token => {
    try {
      const d = jwt.verify(token, JWT_SECRET);
      if (d.rol === 'personal') { const p = db.personal.find(x => x.id === d.id); if (p) socket.join('u:' + p.unidadId); }
      if (d.rol === 'c2') { const op = db.operadores.find(x => x.id === d.id); if (op) socket.join(esAdmin(op) ? 'c2:admin' : 'c2:' + op.unidadId); }
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`\n  ALERTA UAS en marcha`);
  console.log(`  Personal:  http://localhost:${PORT}/`);
  console.log(`  C2:        http://localhost:${PORT}/c2   (usuario: c2admin)`);
  console.log(`  Unidades:  ${db.unidades.map(u => `${u.sigla} (código ${u.codigo})`).join(' · ')}\n`);
});
