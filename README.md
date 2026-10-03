# ALERTA UAS · Prototipo Fase 1

Sistema de alerta temprana por ataque con dron. Un **Centro de Comando y Control (CCOSD)** emite la alerta y el **personal** la recibe en el teléfono con alarma sonora, vibración y pantalla completa. Cada persona confirma su estado y el CCOSD lo ve en tiempo real.

> ⚠️ Esto es un **prototipo académico/demostrativo**. No es para uso operacional sin el aval de TIC y ciberdefensa de la FAC. Consulte "Antes de un uso real" al final.

## Usuario y contraseña del administrador principal

Se definen al inicio de `server.js`:
```js
const ADMIN_USUARIO = 'c2admin';
const ADMIN_CLAVE = 'Cambiar123*';
```
Se aplican **cada vez que arranca el servidor**, aunque ya existan datos. Si existen las variables de entorno `C2_USUARIO` / `C2_PASSWORD` (por ejemplo en Render), estas tienen prioridad. El usuario no distingue mayúsculas de minúsculas. Los operadores de unidad cambian su propia clave desde el panel (CAMBIAR CLAVE).

## Gestión de usuarios (panel CCOSD)

- **Operadores** (solo administrador, en Administración → Operadores): crear, **cambiar clave** (cierra sus sesiones abiertas) y **eliminar**. El administrador principal no se elimina; su clave se define en Render (`C2_PASSWORD`).
- **Personal inscrito**: lista con buscador. El administrador ve a todos; cada operador ve solo su unidad. **Dar de baja** borra la inscripción y los avisos push; el teléfono vuelve a la pantalla de inscripción.
- El personal no tiene contraseña: se inscribe con el código de su unidad.
- **Unidades** (solo administrador): **editar** nombre, sigla y ubicación (el código, el escudo y el personal no cambian) y **eliminar** (solo si no tiene personal, operadores ni alertas activas).

## Sonido de alerta

- **Ataque:** `public/sonidos/ataque.mp3`, en bucle hasta que la persona responda. Para cambiarlo, reemplace ese archivo con otro MP3 del mismo nombre.
- **Amenaza y Zona despejada:** sirena generada por la app. Para darles audio propio, agregue el archivo en `public/sonidos/` y su ruta en `SONIDOS`, en `public/comun.js`.

## Unidades (multi-unidad)

- Cada **unidad** tiene un **código de inscripción** propio, de 6 caracteres. El personal queda asignado a la unidad según el código con que se inscribe.
- **Administrador general** (`c2admin`): crea unidades y operadores, alerta a una, a varias o a todas las unidades, y ve todo.
- **Operador de unidad**: solo alerta a su unidad y solo ve su personal, sus alertas y su bitácora.
- El **personal** solo recibe y ve las alertas de su unidad.
- **Escudo por unidad:** el administrador lo sube desde el CCOSD ("cambiar escudo"; PNG, JPG o WEBP; se reduce a 256 px). El personal ve el escudo de su unidad en el encabezado, en su perfil y en la pantalla de alarma. Sin escudo propio se muestra el del COPAF. Se guarda en `data/escudos/`.
- Si un código se filtra, el administrador lo **renueva**. Los ya inscritos no se afectan.
- Al arrancar por primera vez existe la unidad `PRUEBA`, con el código de la variable `CODIGO_UNIDAD` (por defecto `FAC2026`).

## Qué incluye

| Parte | Ruta | Función |
|---|---|---|
| Vista del personal (PWA) | `/` | Estado actual, mapa de zonas, historial, inscripción, alarma y confirmación |
| Panel CCOSD | `/c2` | Login, modo SIMULACRO/REAL, zona en mapa, 3 plantillas, confirmación, tablero de respuestas, falsa alarma, bitácora |
| Backend | `server.js` | API REST + Socket.IO (tiempo real) + Web Push |

**Salvaguardas implementadas:**
- Modo SIMULACRO por defecto, visualmente distinto (azul y rayado) del modo REAL (rojo).
- Una alerta REAL exige escribir `ENVIAR` en una ventana de confirmación, y el servidor lo valida.
- Botón de **Falsa alarma**, que cancela la alerta en todos los teléfonos al instante.
- La alerta "Zona despejada" cierra automáticamente las alertas activas.
- Bitácora de auditoría: logins, intentos fallidos, alertas enviadas y cerradas.
- OPSEC: la notificación push solo dice "ALERTA – Abra la aplicación". Los detalles se ven dentro de la app.
- Bloqueo tras 5 intentos de login fallidos (15 min), contraseñas con bcrypt y sesiones JWT.

## Paso a paso: correrlo en su computador

1. Instale **Node.js 20 o superior** desde https://nodejs.org
2. Descomprima la carpeta y abra una terminal dentro de ella.
3. Instale las dependencias:
   ```bash
   npm install
   ```
4. Inicie el servidor:
   ```bash
   npm start
   ```
5. Abra **http://localhost:3000/c2** e ingrese con el usuario `c2admin` y la contraseña `Cambiar123*`.
6. En otra ventana (o en el celular) abra **http://localhost:3000**, inscríbase con el código de unidad `FAC2026` y toque **Activar avisos**.
7. En el CCOSD, toque el mapa, elija el tipo de alerta y emita. El teléfono sonará y mostrará la alarma.

**Para probar desde el celular en la misma red WiFi:** use la IP del computador, por ejemplo `http://192.168.1.10:3000`. Las notificaciones push y la instalación como app solo funcionan con **HTTPS** (o en `localhost`), así que para eso hay que publicarlo en internet (siguiente sección).

## Paso a paso: publicarlo en internet (como el ejemplo de Base44)

Opción gratuita y sencilla: **Render.com**
1. Suba la carpeta a un repositorio de GitHub (el archivo `.gitignore` ya excluye `data/` y `node_modules/`).
2. En Render: *New → Web Service* y conecte el repositorio.
3. Configure el *Build command* como `npm install` y el *Start command* como `npm start`.
4. En *Environment* defina estas variables:
   - `C2_USUARIO`: nombre del usuario administrador (por defecto `c2admin`)
   - `C2_PASSWORD`: una contraseña fuerte para el administrador
   - `CODIGO_UNIDAD`: el código de la unidad de prueba inicial
   - `VAPID_CONTACT`: `mailto:su-correo@dominio`
5. Agregue un *Persistent Disk* montado en `/opt/render/project/src/data`, para que las alertas y los inscritos no se borren al reiniciar.
6. Render le entrega una URL con HTTPS: esa es la dirección para el personal.

Alternativas: Railway o Fly.io. Para producción: un servidor institucional aprobado.

## Servidor propio

### Opción A: computador o mini PC propio + Cloudflare Tunnel (gratis)
Publica el servidor con HTTPS sin abrir puertos del router.
1. En el equipo (Windows o Linux), instale Node.js 20, el proyecto y arránquelo con `npm start`.
2. Para que se mantenga encendido y arranque solo: `npm i -g pm2`, luego `pm2 start server.js --name alerta-uas` y `pm2 save`.
3. Cree una cuenta gratuita en Cloudflare e instale `cloudflared`.
4. Prueba rápida: `cloudflared tunnel --url http://localhost:3000` entrega una dirección `https://...trycloudflare.com` temporal.
5. Uso fijo: registre un dominio (unos USD 10 al año), agréguelo a Cloudflare y cree un *tunnel* con nombre (Zero Trust → Networks → Tunnels) que apunte a `http://localhost:3000`.
6. Recomendado: en Cloudflare Zero Trust proteja la ruta `/c2` con una política de acceso (por ejemplo, un código enviado al correo del operador).

Limitaciones: el equipo debe estar encendido 24/7 con energía de respaldo (UPS) e internet estable. Si se apaga, no hay alertas.

### Opción B: VPS (servidor virtual en la nube, unos USD 5–6 al mes)
1. Cree un VPS Ubuntu 24.04 (DigitalOcean, Hetzner, Vultr, etc.) con 1 vCPU y 1–2 GB de RAM.
2. Instale Node.js 20, Nginx y Certbot; clone el repositorio; `npm install`; `pm2 start server.js`.
3. Configure Nginx como proxy inverso hacia `localhost:3000`, con soporte para WebSocket (`proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";`).
4. `certbot --nginx -d su-dominio` para el HTTPS gratuito.
5. Firewall: abra solo los puertos 22 (restringido a su IP), 80 y 443.
6. Respaldos: copie la carpeta `data/` todos los días.

## Instalar en el celular

- **Android (Chrome):** abra la URL, luego menú ⋮ → *Agregar a pantalla principal*, y toque *Activar avisos*.
- **iPhone (Safari, iOS 16.4 o superior):** botón Compartir → *Agregar a inicio*. Abra la app **desde el ícono** y toque *Activar avisos*. En iPhone, la push web solo funciona si la app está agregada a la pantalla de inicio.

## Limitaciones conocidas de esta fase (y cómo se resuelven)

| Limitación | Solución en fases siguientes |
|---|---|
| La alarma web **no suena con el teléfono en silencio/No molestar** y con la app cerrada solo llega la notificación estándar | Fase 2: app nativa (React Native/Flutter) con canal de máxima prioridad en Android y *Critical Alerts* de Apple en iOS |
| Base de datos en archivo JSON | PostgreSQL |
| Operadores sin MFA | MFA y regla de dos personas para alertas REAL |
| Inscripción con código por unidad | Autenticación institucional (directorio de la FAC) |
| Solo canal push y web | Respaldo automático por SMS si no hay confirmación en X segundos, más integración con sirenas |
| Mapa con teselas públicas (CARTO/OSM) | Servidor de mapas propio para operar sin internet externo |

## Antes de un uso real

- Aval de TIC y ciberdefensa, y pruebas de penetración.
- Alinear niveles e instrucciones con los protocolos y ROE C-UAS vigentes (se editan en `NIVELES`, dentro de `server.js`).
- Tratamiento de datos personales conforme a la Ley 1581 de 2012.
- Procedimiento escrito que diga quién está autorizado a emitir alertas.
- Simulacros periódicos y una prueba semanal del sistema.

## Estructura

```
server.js            Backend (API, tiempo real, push, auditoría)
public/index.html    Vista del personal
public/personal.js   Lógica del personal (alarma, confirmación, push)
public/sw.js         Service worker (recibe push con la app cerrada)
public/c2/           Panel del Centro de Comando y Control
public/comun.js      Mapa, sirena y utilidades compartidas
public/estilos.css   Estilos (tema oscuro)
data/                Se crea automáticamente: db.json y secrets.json (NO compartir)
```
