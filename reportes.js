// ============================================================
//  Reportes PDF para auditoría (CCOSD)
//   GET /api/c2/reportes/personal.pdf      → personal inscrito (según las unidades del operador)
//   GET /api/c2/reportes/alerta/:id.pdf    → reporte completo de una alerta
// ============================================================
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ZONA = process.env.REPORTE_TZ || 'America/Bogota';
const LOGO = path.join(__dirname, 'public', 'logo.png');
const C = { texto: '#111111', suave: '#555555', linea: '#cccccc', banda: '#f2f2f2', rojo: '#b3261e', verde: '#1e7b4f', ambar: '#9a6400', azul: '#1f5fa8' };

const fecha = iso => iso ? new Date(iso).toLocaleString('es-CO', { timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '—';
function duracion(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${r} s` : `${r} s`;
}
const ESTADO_RESP = { A_SALVO: 'A salvo', RECIBIDO: 'Recibido', NECESITO_APOYO: 'Necesito apoyo', PENDIENTE: 'Sin respuesta' };
const ESTADO_ALERTA = { ACTIVA: 'Activa', RESUELTA: 'Resuelta', FALSA_ALARMA: 'Falsa alarma' };
const ESTADO_ACCESO = { APROBADO: 'Aprobado', PENDIENTE: 'Pendiente', VENCIDO: 'Vencido', RECHAZADO: 'Rechazado' };

// ---------- Utilidades de dibujo ----------
function nuevoDoc(titulo, sub, op) {
  const doc = new PDFDocument({ size: 'LETTER', margins: { top: 50, bottom: 60, left: 50, right: 50 }, bufferPages: true,
    info: { Title: titulo, Author: 'ALARMA ATAQUE - UMA', Subject: 'Reporte de auditoría', Creator: op.usuario } });
  const folio = crypto.randomBytes(4).toString('hex').toUpperCase();
  const generado = new Date().toISOString();
  // Encabezado
  if (fs.existsSync(LOGO)) doc.image(LOGO, 50, 42, { width: 54 });
  doc.fillColor(C.texto).font('Helvetica-Bold').fontSize(16).text('ALARMA ATAQUE - UMA', 116, 46);
  doc.font('Helvetica').fontSize(11).fillColor(C.suave).text(titulo, 116, 66);
  doc.fontSize(8.5).text(sub, 116, 82, { width: 446 });
  doc.moveTo(50, 104).lineTo(562, 104).strokeColor(C.linea).lineWidth(1).stroke();
  doc.fontSize(8.5).fillColor(C.suave)
     .text(`Generado: ${fecha(generado)} (hora Colombia)   ·   Por: ${op.usuario}${op.nombre ? ' – ' + op.nombre : ''}   ·   Folio: ${folio}`, 50, 110, { width: 512 });
  doc.y = 132; doc.x = 50;
  doc._folio = folio; doc._generado = generado;
  return doc;
}
function pies(doc) {
  const r = doc.bufferedPageRange();
  for (let i = r.start; i < r.start + r.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // escribir el pie sin que PDFKit cree páginas nuevas
    const y = doc.page.height - 42;
    doc.save().moveTo(50, y - 6).lineTo(562, y - 6).strokeColor(C.linea).lineWidth(.5).stroke().restore();
    doc.font('Helvetica').fontSize(7.5).fillColor(C.suave)
       .text(`Documento de uso interno · Folio ${doc._folio} · Información generada automáticamente por el sistema; no contiene datos clasificados de operaciones.`, 50, y, { width: 420, lineBreak: false })
       .text(`Página ${i - r.start + 1} de ${r.count}`, 470, y, { width: 92, align: 'right', lineBreak: false });
  }
}
function seccion(doc, t) {
  asegurar(doc, 95); // el título nunca queda solo al final de una página
  doc.moveDown(.6).font('Helvetica-Bold').fontSize(11.5).fillColor(C.texto).text(t, 50, doc.y);
  doc.moveTo(50, doc.y + 2).lineTo(562, doc.y + 2).strokeColor(C.texto).lineWidth(.8).stroke();
  doc.moveDown(.5);
}
function asegurar(doc, alto) { if (doc.y + alto > doc.page.height - doc.page.margins.bottom) { doc.addPage(); doc.y = doc.page.margins.top; } }
// Pares etiqueta/valor en dos columnas
function campos(doc, pares) {
  const anchoEt = 120, anchoVal = 392;
  for (const [et, val] of pares) {
    const v = String(val ?? '—') || '—';
    const h = Math.max(doc.font('Helvetica').fontSize(9.5).heightOfString(v, { width: anchoVal }), 12) + 4;
    asegurar(doc, h);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.suave).text(et, 50, y, { width: anchoEt });
    doc.font('Helvetica').fontSize(9.5).fillColor(C.texto).text(v, 50 + anchoEt, y, { width: anchoVal });
    doc.y = y + h;
  }
}
// Tabla con encabezado repetido en cada página
function tabla(doc, cols, filas, opc = {}) {
  const x0 = 50, fs_ = opc.fs || 8.5, pad = 4;
  const encabezado = () => {
    asegurar(doc, 40);
    const y = doc.y;
    doc.rect(x0, y, 512, 18).fill(C.texto);
    let x = x0;
    for (const c of cols) { doc.font('Helvetica-Bold').fontSize(fs_).fillColor('#ffffff').text(c.t, x + pad, y + 5, { width: c.w - 2 * pad, lineBreak: false, ellipsis: true }); x += c.w; }
    doc.y = y + 18;
  };
  encabezado();
  if (!filas.length) { doc.font('Helvetica-Oblique').fontSize(fs_).fillColor(C.suave).text('Sin registros.', x0 + pad, doc.y + 5); doc.moveDown(.6); return; }
  filas.forEach((f, i) => {
    const alto = Math.max(...cols.map((c, j) => doc.font(c.b ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs_).heightOfString(String(f[j] ?? '—'), { width: c.w - 2 * pad }))) + 2 * pad;
    if (doc.y + alto > doc.page.height - doc.page.margins.bottom) { doc.addPage(); doc.y = doc.page.margins.top; encabezado(); }
    const y = doc.y;
    if (i % 2) doc.rect(x0, y, 512, alto).fill(C.banda);
    let x = x0;
    cols.forEach((c, j) => {
      const color = (opc.color && opc.color(f, j)) || C.texto;
      doc.font(c.b ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs_).fillColor(color).text(String(f[j] ?? '—'), x + pad, y + pad, { width: c.w - 2 * pad });
      x += c.w;
    });
    doc.y = y + alto;
  });
  doc.moveTo(x0, doc.y).lineTo(x0 + 512, doc.y).strokeColor(C.linea).lineWidth(.5).stroke();
  doc.moveDown(.6);
}
// Fila de indicadores
function indicadores(doc, items) {
  asegurar(doc, 52);
  const w = 512 / items.length, y = doc.y;
  items.forEach(([n, et, color], i) => {
    const x = 50 + i * w;
    doc.rect(x + 2, y, w - 4, 44).lineWidth(.8).strokeColor(C.linea).stroke();
    doc.font('Helvetica-Bold').fontSize(16).fillColor(color || C.texto).text(String(n), x + 2, y + 6, { width: w - 4, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor(C.suave).text(et.toUpperCase(), x + 2, y + 28, { width: w - 4, align: 'center' });
  });
  doc.y = y + 52; doc.x = 50;
}
function enviar(res, doc, nombre) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.setHeader('Cache-Control', 'no-store');
  pies(doc); doc.pipe(res); doc.end();
}
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: ZONA }); // AAAA-MM-DD

module.exports = function (app, ctx) {
  const { db, auth, unidad, unidadesDe, puedeVer, esAdmin, estadoAcceso, activo, auditar, NIVELES } = ctx;

  // ================= Personal inscrito =================
  app.get('/api/c2/reportes/personal.pdf', auth('c2'), (req, res) => {
    const op = req.op, vis = unidadesDe(op);
    const unidades = db.unidades.filter(u => vis.includes(u.id));
    const conPush = new Set(db.suscripciones.map(s => s.personalId));
    const personal = db.personal.filter(p => vis.includes(p.unidadId))
      .sort((a, b) => ((unidad(a.unidadId) || {}).sigla || '').localeCompare((unidad(b.unidadId) || {}).sigla || '') || a.nombre.localeCompare(b.nombre));
    const alcance = esAdmin(op) ? 'Todas las unidades' : unidades.map(u => `${u.sigla} – ${u.nombre}`).join(', ');
    const doc = nuevoDoc('Reporte de personal inscrito', `Alcance: ${alcance}`, op);

    const cuenta = e => personal.filter(p => estadoAcceso(p) === e).length;
    seccion(doc, 'Resumen');
    indicadores(doc, [[personal.length, 'Total registros'], [cuenta('APROBADO'), 'Con acceso', C.verde], [cuenta('PENDIENTE'), 'Pendientes', C.ambar],
                      [cuenta('VENCIDO'), 'Vencidos', C.rojo], [cuenta('RECHAZADO'), 'Rechazados', C.rojo], [personal.filter(p => conPush.has(p.id)).length, 'Con avisos push', C.azul]]);

    seccion(doc, 'Personal por unidad');
    tabla(doc, [{ t: 'Sigla', w: 80, b: true }, { t: 'Unidad', w: 172 }, { t: 'Con acceso', w: 65 }, { t: 'Pendientes', w: 65 }, { t: 'Inactivos', w: 70 }, { t: 'Con push', w: 60 }],
      unidades.map(u => {
        const ps = personal.filter(p => p.unidadId === u.id);
        return [u.sigla, u.nombre, ps.filter(activo).length, ps.filter(p => p.estado === 'PENDIENTE').length,
                ps.filter(p => ['VENCIDO', 'RECHAZADO'].includes(estadoAcceso(p))).length, ps.filter(p => conPush.has(p.id)).length];
      }));

    seccion(doc, 'Detalle del personal');
    tabla(doc, [{ t: '#', w: 22 }, { t: 'Grado y nombre', w: 120, b: true }, { t: 'Unidad', w: 58 }, { t: 'Estado', w: 58 }, { t: 'Vigencia', w: 82 },
                { t: 'Aval por', w: 58 }, { t: 'Solicitó', w: 74 }, { t: 'Push', w: 40 }],
      personal.map((p, i) => {
        const e = estadoAcceso(p);
        return [i + 1, p.nombre, (unidad(p.unidadId) || {}).sigla, ESTADO_ACCESO[e] || e,
                e === 'PENDIENTE' || e === 'RECHAZADO' ? '—' : p.vence ? (e === 'VENCIDO' ? 'Venció ' : 'Hasta ') + fecha(p.vence) : 'Indeterminada',
                p.avalPor ? `${p.avalPor}${p.avalFecha ? '\n' + fecha(p.avalFecha) : ''}` : '—', fecha(p.solicitado || p.creado), conPush.has(p.id) ? 'Sí' : 'No'];
      }), { fs: 7.8, color: (f, j) => j === 3 ? ({ Aprobado: C.verde, Pendiente: C.ambar, Vencido: C.rojo, Rechazado: C.rojo }[f[3]]) : null });

    // Altas, bajas y cambios de acceso (bitácora)
    const acciones = ['SOLICITUD', 'ACCESO_APROBADO', 'ACCESO_RECHAZADO', 'ACCESO_VENCIDO', 'PERSONAL_ELIMINADO'];
    const movs = db.auditoria.filter(l => acciones.includes(l.accion) && (esAdmin(op) || (l.unidades || []).some(id => vis.includes(id)))).slice(0, 300);
    seccion(doc, 'Movimientos de inscripción (bitácora)');
    tabla(doc, [{ t: 'Fecha', w: 100 }, { t: 'Actor', w: 92 }, { t: 'Acción', w: 100 }, { t: 'Detalle', w: 220 }],
      movs.map(l => [fecha(l.fecha), l.actor, l.accion.replace(/_/g, ' '), l.detalle]), { fs: 7.5 });

    auditar(op.usuario, 'REPORTE_GENERADO', `Personal inscrito · ${alcance} · folio ${doc._folio}`, vis);
    enviar(res, doc, `personal-inscrito-${hoy()}.pdf`);
  });

  // ================= Reporte de una alerta =================
  app.get('/api/c2/reportes/alerta/:id.pdf', auth('c2'), (req, res) => {
    const op = req.op, a = db.alertas.find(x => x.id === req.params.id);
    if (!a || !puedeVer(op, a)) return res.status(404).json({ error: 'Alerta no encontrada' });
    const vis = new Set(unidadesDe(op).filter(id => a.unidades.includes(id)));
    const siglas = a.siglasGuardadas || a.unidades.map(id => (unidad(id) || {}).sigla || '?').join(', ');
    const doc = nuevoDoc(`Reporte de alerta ${a.id}`, `${a.titulo} · Unidades: ${siglas}`, op);

    // Destinatarios: los guardados al emitir (o, en alertas antiguas, el personal actual de esas unidades)
    const confs = db.confirmaciones.filter(c => c.alertaId === a.id);
    let dest = (a.destinatarios || db.personal.filter(p => a.unidades.includes(p.unidadId)).map(p => ({ id: p.id, nombre: p.nombre, unidad: (unidad(p.unidadId) || {}).sigla })));
    // operadores de unidad solo ven a su personal
    if (!esAdmin(op)) { const sig = new Set([...vis].map(id => (unidad(id) || {}).sigla)); dest = dest.filter(d => sig.has(d.unidad)); }
    confs.forEach(c => { if (!dest.some(d => d.id === c.personalId) && (esAdmin(op) || [...vis].some(id => (unidad(id) || {}).sigla === c.unidad))) dest.push({ id: c.personalId, nombre: c.nombre || '(sin nombre)', unidad: c.unidad }); });
    const filas = dest.map(d => {
      const c = confs.find(x => x.personalId === d.id);
      const primera = c ? (c.primera || c.fecha) : null;
      return { ...d, c, estado: c ? c.estado : 'PENDIENTE', primera, t: primera ? new Date(primera) - new Date(a.creada) : null };
    }).sort((x, y) => (x.t == null) - (y.t == null) || (x.t || 0) - (y.t || 0));

    seccion(doc, 'Datos de la alerta');
    const tipo = (NIVELES[a.nivel] || {}).titulo || a.nivel;
    campos(doc, [
      ['Identificador', a.id], ['Tipo de evento', tipo], ['Modo', a.modo === 'REAL' ? 'REAL' : 'SIMULACRO (ejercicio)'],
      ['Estado', ESTADO_ALERTA[a.estado] || a.estado], ['Unidades destino', siglas],
      ['Zona', `${a.zona.nombre} · radio ${a.zona.radio} m · coordenadas ${a.zona.lat.toFixed(5)}, ${a.zona.lng.toFixed(5)}`],
      ['Instrucción enviada', a.instruccion], ['Mensaje adicional', a.mensaje || '—'],
      ['Emitida por', a.enviadaPor || '—'], ['Emitida', fecha(a.creada)],
      ['Cerrada por', a.cerradaPor || (a.estado === 'ACTIVA' ? 'Sigue activa' : '—')], ['Cerrada', a.cerrada ? fecha(a.cerrada) : '—'],
      ['Duración', a.cerrada ? duracion(new Date(a.cerrada) - new Date(a.creada)) : `${duracion(Date.now() - new Date(a.creada))} (en curso)`],
      ['Notificaciones push', a.push ? `${a.push.enviadas} entregadas al servicio · ${a.push.fallidas} fallidas` : '—']
    ]);

    seccion(doc, 'Resumen de respuestas');
    const n = e => filas.filter(f => f.estado === e).length;
    const resp = filas.filter(f => f.t != null);
    const prom = resp.length ? resp.reduce((s, f) => s + f.t, 0) / resp.length : null;
    indicadores(doc, [[filas.length, 'Destinatarios'], [n('A_SALVO'), 'A salvo', C.verde], [n('RECIBIDO'), 'Recibido', C.azul],
                      [n('NECESITO_APOYO'), 'Necesito apoyo', C.rojo], [n('PENDIENTE'), 'Sin respuesta', C.ambar]]);
    campos(doc, [['Tasa de respuesta', filas.length ? `${Math.round(resp.length / filas.length * 100)} % (${resp.length} de ${filas.length})` : '—'],
                 ['Tiempo promedio', duracion(prom)], ['Respuesta más rápida', resp.length ? duracion(Math.min(...resp.map(f => f.t))) : '—'],
                 ['Respuesta más lenta', resp.length ? duracion(Math.max(...resp.map(f => f.t))) : '—']]);

    seccion(doc, 'Respuestas del personal');
    tabla(doc, [{ t: '#', w: 22 }, { t: 'Grado y nombre', w: 140, b: true }, { t: 'Unidad', w: 62 }, { t: 'Estado final', w: 82 },
                { t: 'Primera respuesta', w: 96 }, { t: 'Tiempo', w: 50 }, { t: 'Cambios', w: 60 }],
      filas.map((f, i) => [i + 1, f.nombre, f.unidad, ESTADO_RESP[f.estado], f.primera ? fecha(f.primera) : '—', duracion(f.t),
        f.c && f.c.historial && f.c.historial.length > 1 ? f.c.historial.map(h => ESTADO_RESP[h.estado]).join(' → ') : '—']),
      { fs: 7.8, color: (f, j) => j === 3 ? ({ 'A salvo': C.verde, 'Recibido': C.azul, 'Necesito apoyo': C.rojo, 'Sin respuesta': C.ambar }[f[3]]) : null });

    const apoyos = filas.filter(f => f.estado === 'NECESITO_APOYO' || (f.c && (f.c.historial || []).some(h => h.estado === 'NECESITO_APOYO')));
    seccion(doc, 'Solicitudes de apoyo');
    tabla(doc, [{ t: 'Grado y nombre', w: 120, b: true }, { t: 'Unidad', w: 55 }, { t: 'Ubicación reportada', w: 140 }, { t: 'Heridas', w: 120 }, { t: 'Reportado', w: 77 }],
      apoyos.map(f => [f.nombre, f.unidad, (f.c && f.c.ubicacion) || 'No indicó',
        f.c && f.c.herido === true ? 'HERIDO: ' + (f.c.herida || 'sin descripción') : f.c && f.c.herido === false ? 'Sin heridas' : 'No indicó',
        f.c && f.c.detalleFecha ? fecha(f.c.detalleFecha) : fecha(f.primera)]),
      { fs: 7.8, color: (f, j) => j === 3 && String(f[3]).startsWith('HERIDO') ? C.rojo : null });

    // Bitácora durante la alerta para las unidades involucradas
    const ini = new Date(a.creada).getTime(), fin = (a.cerrada ? new Date(a.cerrada).getTime() : Date.now()) + 5 * 60e3;
    const log = db.auditoria.filter(l => {
      const t = new Date(l.fecha).getTime();
      return t >= ini && t <= fin && (String(l.detalle).includes(a.id) || (l.unidades || []).some(id => vis.has(id))) && !['LOGIN', 'LOGIN_FALLIDO', 'REPORTE_GENERADO'].includes(l.accion);
    }).reverse().slice(0, 300);
    seccion(doc, 'Bitácora durante la alerta');
    tabla(doc, [{ t: 'Fecha', w: 100 }, { t: 'Actor', w: 92 }, { t: 'Acción', w: 100 }, { t: 'Detalle', w: 220 }],
      log.map(l => [fecha(l.fecha), l.actor, l.accion.replace(/_/g, ' '), l.detalle]), { fs: 7.5 });

    auditar(op.usuario, 'REPORTE_GENERADO', `Alerta ${a.id} · folio ${doc._folio}`, a.unidades);
    enviar(res, doc, `alerta-${a.id}-${new Date(a.creada).toLocaleDateString('en-CA', { timeZone: ZONA })}.pdf`);
  });
};
