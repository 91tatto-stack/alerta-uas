// ============================================================
//  ALERTA UAS - Prototipo Fase 1
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
const CODIGO_UNIDAD = process.env.CODIGO_UNIDAD || 'FAC2026'; // código para que el personal se inscriba
const CONTACTO_VAPID = process.env.VAPID_CONTACT || 'mailto:admin@example.com';

fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

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
function cargarDB() {
  if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return {
    operadores: [
      // Usuario inicial del C2. CAMBIAR la contraseña antes de cualquier uso real.
      { id: 'op-1', usuario: 'c2admin', nombre: 'Operador C2', hash: bcrypt.hashSync(process.env.C2_PASSWORD || 'Cambiar123*', 10) }
    ],
    personal: [],       // { id, nombre, unidad, creado }
    suscripciones: [],  // { personalId, sub }
    alertas: [],        // ver crearAlerta()
    confirmaciones: [], // { alertaId, personalId, estado, fecha }
    auditoria: []       // { fecha, actor, accion, detalle }
  };
}
let db = cargarDB();
let guardando = null;
function guardar() {
  clearTimeout(guardando);
  guardando = setTimeout(() => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)), 100);
}
function auditar(actor, accion, detalle) {
  db.auditoria.unshift({ fecha: new Date().toISOString(), actor, accion, detalle });
  db.auditoria = db.auditoria.slice(0, 1000);
  guardar();
}

// ---------- Catálogo de niveles (deben coincidir con los protocolos / ROE C-UAS) ----------
const NIVELES = {
  ATAQUE:    { titulo: 'ATAQUE CON DRON EN CURSO', instruccion: 'Busque refugio inmediato. Aléjese de ventanas y espacios abiertos. Espere instrucciones.' },
  AMENAZA:   { titulo: 'AMENAZA UAS DETECTADA',    instruccion: 'Esté alerta. Diríjase a la zona de refugio más cercana y mantenga el teléfono a mano.' },
  DESPEJADO: { titulo: 'ZONA DESPEJADA',           instruccion: 'La amenaza ha terminado. Retome actividades siguiendo las órdenes de su superior.' }
};
const ESTADOS_CONFIRMACION = ['RECIBIDO', 'A_SALVO', 'NECESITO_APOYO'];

// ---------- App ----------
const app = express();
app.use(express.json({ limit: '50kb' }));
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

// ---------- Autenticación ----------
function firmar(payload, horas) { return jwt.sign(payload, JWT_SECRET, { expiresIn: `${horas}h` }); }
function auth(rol) {
  return (req, res, next) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    try {
      const data = jwt.verify(token, JWT_SECRET);
      if (rol && data.rol !== rol) return res.status(403).json({ error: 'Sin permiso' });
      req.user = data; next();
    } catch { res.status(401).json({ error: 'Sesión inválida o vencida' }); }
  };
}

// Limitador simple de intentos de login (anti fuerza bruta)
const intentos = new Map();
function limitarLogin(req, res, next) {
  const k = req.ip; const now = Date.now();
  const r = (intentos.get(k) || []).filter(t => now - t < 15 * 60 * 1000);
  if (r.length >= 5) return res.status(429).json({ error: 'Demasiados intentos. Espere 15 minutos.' });
  r.push(now); intentos.set(k, r); next();
}

app.post('/api/c2/login', limitarLogin, (req, res) => {
  const { usuario, clave } = req.body || {};
  const op = db.operadores.find(o => o.usuario === usuario);
  if (!op || !bcrypt.compareSync(String(clave || ''), op.hash)) {
    auditar(String(usuario || '?'), 'LOGIN_FALLIDO', 'Intento de acceso al C2');
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  auditar(op.usuario, 'LOGIN', 'Ingreso al C2');
  res.json({ token: firmar({ id: op.id, usuario: op.usuario, nombre: op.nombre, rol: 'c2' }, 12), nombre: op.nombre });
});

// Inscripción del personal con código de unidad
app.post('/api/registro', (req, res) => {
  const { nombre, unidad, codigo } = req.body || {};
  if (codigo !== CODIGO_UNIDAD) return res.status(403).json({ error: 'Código de unidad incorrecto' });
  if (!nombre || !unidad) return res.status(400).json({ error: 'Nombre y unidad son obligatorios' });
  const p = { id: 'p-' + crypto.randomUUID(), nombre: String(nombre).slice(0, 80), unidad: String(unidad).slice(0, 60), creado: new Date().toISOString() };
  db.personal.push(p); guardar();
  auditar(p.nombre, 'REGISTRO', `Personal inscrito (${p.unidad})`);
  res.json({ token: firmar({ id: p.id, nombre: p.nombre, unidad: p.unidad, rol: 'personal' }, 24 * 180), perfil: p });
});

// ---------- Web Push ----------
app.get('/api/vapid', (req, res) => res.json({ key: process.env.VAPID_PUBLIC || SECRETS.vapidPublic }));
app.post('/api/suscribir', auth('personal'), (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Suscripción inválida' });
  db.suscripciones = db.suscripciones.filter(s => s.sub.endpoint !== sub.endpoint);
  db.suscripciones.push({ personalId: req.user.id, sub }); guardar();
  res.json({ ok: true });
});

async function enviarPush(alerta) {
  // OPSEC: la notificación NO lleva detalles (pasa por servidores de Google/Apple/Mozilla).
  const payload = JSON.stringify({
    title: alerta.modo === 'SIMULACRO' ? 'SIMULACRO – Alerta UAS' : 'ALERTA – Abra la aplicación',
    body: 'Hay una alerta activa. Abra la app para ver instrucciones.',
    tag: 'alerta-' + alerta.id,
    nivel: alerta.nivel
  });
  const res = await Promise.allSettled(db.suscripciones.map(s =>
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
           zona: a.zona, estado: a.estado, creada: a.creada, cerrada: a.cerrada };
}
function resumenConfirmaciones(alertaId) {
  const conf = db.confirmaciones.filter(c => c.alertaId === alertaId);
  const lista = db.personal.map(p => {
    const c = conf.find(x => x.personalId === p.id);
    return { id: p.id, nombre: p.nombre, unidad: p.unidad, estado: c ? c.estado : 'PENDIENTE', fecha: c ? c.fecha : null };
  });
  const cuenta = { RECIBIDO: 0, A_SALVO: 0, NECESITO_APOYO: 0, PENDIENTE: 0 };
  lista.forEach(l => cuenta[l.estado]++);
  return { cuenta, lista };
}

app.get('/api/alertas', (req, res) => {
  res.json({
    activas: db.alertas.filter(a => a.estado === 'ACTIVA').map(alertaPublica),
    historial: db.alertas.filter(a => a.estado !== 'ACTIVA').slice(0, 30).map(alertaPublica)
  });
});

app.post('/api/c2/alertas', auth('c2'), async (req, res) => {
  const { nivel, modo, zona, mensaje, confirmacion } = req.body || {};
  if (!NIVELES[nivel]) return res.status(400).json({ error: 'Nivel inválido' });
  if (!['REAL', 'SIMULACRO'].includes(modo)) return res.status(400).json({ error: 'Modo inválido' });
  if (!zona || typeof zona.lat !== 'number' || typeof zona.lng !== 'number') return res.status(400).json({ error: 'Seleccione la zona en el mapa' });
  // Salvaguarda anti-error (lección Hawái 2018): una alerta REAL exige escribir la palabra de confirmación
  if (modo === 'REAL' && confirmacion !== 'ENVIAR') return res.status(400).json({ error: 'Confirmación requerida para alerta REAL' });

  const a = {
    id: crypto.randomUUID().slice(0, 8), nivel, modo,
    titulo: (modo === 'SIMULACRO' ? 'SIMULACRO · ' : '') + NIVELES[nivel].titulo,
    instruccion: NIVELES[nivel].instruccion,
    mensaje: String(mensaje || '').slice(0, 280),
    zona: { lat: zona.lat, lng: zona.lng, radio: Math.min(Math.max(Number(zona.radio) || 1000, 100), 50000), nombre: String(zona.nombre || 'Zona').slice(0, 60) },
    estado: 'ACTIVA', creada: new Date().toISOString(), cerrada: null, enviadaPor: req.user.usuario
  };
  // Una alerta DESPEJADO cierra automáticamente las alertas activas
  if (nivel === 'DESPEJADO') {
    db.alertas.filter(x => x.estado === 'ACTIVA').forEach(x => { x.estado = 'RESUELTA'; x.cerrada = a.creada; io.emit('alerta:actualizada', alertaPublica(x)); });
  }
  db.alertas.unshift(a); guardar();
  io.emit('alerta:nueva', alertaPublica(a));
  const push = await enviarPush(a);
  auditar(req.user.usuario, 'ALERTA_ENVIADA', `${a.modo} · ${a.nivel} · ${a.zona.nombre} · push ok=${push.enviadas} fallo=${push.fallidas}`);
  res.json({ alerta: alertaPublica(a), push });
});

app.post('/api/c2/alertas/:id/cerrar', auth('c2'), (req, res) => {
  const a = db.alertas.find(x => x.id === req.params.id);
  if (!a || a.estado !== 'ACTIVA') return res.status(404).json({ error: 'Alerta no activa' });
  const estado = req.body && req.body.estado === 'FALSA_ALARMA' ? 'FALSA_ALARMA' : 'RESUELTA';
  a.estado = estado; a.cerrada = new Date().toISOString(); guardar();
  io.emit('alerta:actualizada', alertaPublica(a));
  auditar(req.user.usuario, estado === 'FALSA_ALARMA' ? 'FALSA_ALARMA' : 'ALERTA_CERRADA', `${a.id} · ${a.titulo}`);
  res.json({ ok: true });
});

app.get('/api/c2/alertas/:id/confirmaciones', auth('c2'), (req, res) => res.json(resumenConfirmaciones(req.params.id)));
app.get('/api/c2/auditoria', auth('c2'), (req, res) => res.json(db.auditoria.slice(0, 100)));
app.get('/api/c2/resumen', auth('c2'), (req, res) => res.json({ personal: db.personal.length, suscripciones: db.suscripciones.length }));

// Confirmación del personal
app.post('/api/alertas/:id/confirmar', auth('personal'), (req, res) => {
  const a = db.alertas.find(x => x.id === req.params.id);
  const estado = req.body && req.body.estado;
  if (!a) return res.status(404).json({ error: 'Alerta no existe' });
  if (!ESTADOS_CONFIRMACION.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  db.confirmaciones = db.confirmaciones.filter(c => !(c.alertaId === a.id && c.personalId === req.user.id));
  db.confirmaciones.push({ alertaId: a.id, personalId: req.user.id, estado, fecha: new Date().toISOString() }); guardar();
  io.to('c2').emit('confirmacion', { alertaId: a.id, ...resumenConfirmaciones(a.id) });
  res.json({ ok: true });
});

// ---------- Tiempo real ----------
io.on('connection', socket => {
  socket.on('c2:unirse', token => {
    try { if (jwt.verify(token, JWT_SECRET).rol === 'c2') socket.join('c2'); } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`\n  ALERTA UAS en marcha`);
  console.log(`  Personal:  http://localhost:${PORT}/`);
  console.log(`  C2:        http://localhost:${PORT}/c2   (usuario: c2admin)`);
  console.log(`  Código de unidad para inscripción: ${CODIGO_UNIDAD}\n`);
});
