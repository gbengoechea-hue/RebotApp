/**
 * RebotApp — ¿Va a dar la rebotá?
 *
 * La "rebotá" es una caída brusca de la temperatura: que en las próximas 24 horas
 * alguna hora vaya a estar UMBRAL_C grados (6 por defecto) o más por debajo de la
 * misma hora del día anterior.
 *
 * Cloudflare Worker (plan gratuito):
 *  - fetch():      la web (consulta + gestión de avisos)
 *  - scheduled():  se ejecuta cada 30 min y, a las HORAS_REVISION de ZONA, revisa
 *                  a los suscriptores y les avisa
 *  - Almacen:      Durable Object con SQLite (suscripciones y claves de notificación)
 *
 * Canales de aviso:
 *  - Notificaciones del navegador (Web Push, sin instalar nada; en iPhone hay que
 *    añadir la web a la pantalla de inicio). Claves VAPID generadas automáticamente.
 *  - Correo electrónico vía Brevo (opcional: solo si existe el secreto BREVO_API_KEY).
 *  - ntfy (opcional, para quien ya use esa app).
 *
 * Pronóstico: Open-Meteo (gratuito, sin clave).
 */
import { DurableObject } from "cloudflare:workers";
import { ICON_192, ICON_512 } from "./iconos.js";

const H = 3600 * 1000;
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const enc = new TextEncoder();

function cfg(env) {
  return {
    umbral: parseFloat(env.UMBRAL_C ?? "8"),
    horas: (env.HORAS_REVISION ?? "8,20").split(",").map((h) => parseInt(h, 10)),
    zona: env.ZONA ?? "Europe/Madrid",
    silencio: parseInt(env.HORAS_ENTRE_AVISOS ?? "18", 10),
    ntfy: (env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/$/, ""),
    forecastUrl: env.FORECAST_URL ?? "https://api.open-meteo.com/v1/forecast",
    geocodingUrl: env.GEOCODING_URL ?? "https://geocoding-api.open-meteo.com/v1/search",
    brevoUrl: env.BREVO_URL ?? "https://api.brevo.com/v3/smtp/email",
    brevoKey: env.BREVO_API_KEY,
    remitente: env.EMAIL_REMITENTE,
    remitenteNombre: env.EMAIL_NOMBRE ?? "RebotApp",
    get correo() { return Boolean(this.brevoKey && this.remitente); },
  };
}

// ------------------------------------------------------------------ Utilidades
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
const aleatorio = (bytes) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
function unir(...partes) {
  const out = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of partes) { out.set(p, i); i += p.length; }
  return out;
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const emailValido = (e) => /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(e) && e.length <= 200;

// ------------------------------------------------------------------ Almacén (SQLite)
export class Almacen extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS suscriptores (
      id INTEGER PRIMARY KEY,
      nombre TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL,
      topic TEXT UNIQUE NOT NULL, token TEXT UNIQUE NOT NULL,
      ultimo_aviso INTEGER, creado INTEGER NOT NULL)`);
    // Columnas añadidas en la versión 2 (las suscripciones antiguas usaban ntfy)
    for (const col of ["email TEXT", "email_pend TEXT", "email_cod TEXT", "ntfy INTEGER DEFAULT 1", "base TEXT"]) {
      try { this.sql.exec(`ALTER TABLE suscriptores ADD COLUMN ${col}`); } catch { /* ya existe */ }
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS push (
      id INTEGER PRIMARY KEY, sus_id INTEGER NOT NULL,
      endpoint TEXT UNIQUE NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL)`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  /** Claves VAPID de la app: se generan la primera vez y se guardan. */
  async vapid() {
    const fila = this.sql.exec("SELECT v FROM meta WHERE k='vapid'").toArray()[0];
    if (fila) return JSON.parse(fila.v);
    const par = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const v = {
      publica: b64url(await crypto.subtle.exportKey("raw", par.publicKey)),
      privada: await crypto.subtle.exportKey("jwk", par.privateKey),
    };
    this.sql.exec("INSERT OR IGNORE INTO meta (k,v) VALUES ('vapid',?)", JSON.stringify(v));
    return JSON.parse(this.sql.exec("SELECT v FROM meta WHERE k='vapid'").one().v);
  }

  alta(nombre, lat, lon, base) {
    const topic = "rebota-" + aleatorio(12), token = aleatorio(16);
    this.sql.exec("INSERT INTO suscriptores (nombre,lat,lon,topic,token,creado,ntfy,base) VALUES (?,?,?,?,?,?,0,?)",
      nombre, lat, lon, topic, token, Date.now(), base);
    return token;
  }
  porToken(token) {
    const s = this.sql.exec("SELECT * FROM suscriptores WHERE token=?", token).toArray()[0];
    if (!s) return null;
    s.push = this.sql.exec("SELECT * FROM push WHERE sus_id=?", s.id).toArray();
    return s;
  }
  todos() {
    const subs = this.sql.exec("SELECT * FROM suscriptores").toArray();
    const push = this.sql.exec("SELECT * FROM push").toArray();
    for (const s of subs) s.push = push.filter((p) => p.sus_id === s.id);
    return subs;
  }
  baja(id) {
    this.sql.exec("DELETE FROM push WHERE sus_id=?", id);
    this.sql.exec("DELETE FROM suscriptores WHERE id=?", id);
  }
  guardarPush(id, endpoint, p256dh, auth) {
    this.sql.exec(`INSERT INTO push (sus_id,endpoint,p256dh,auth) VALUES (?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET sus_id=excluded.sus_id, p256dh=excluded.p256dh, auth=excluded.auth`,
      id, endpoint, p256dh, auth);
    // Máximo 5 dispositivos por aviso: se quedan los más recientes
    this.sql.exec(`DELETE FROM push WHERE sus_id=? AND id NOT IN
      (SELECT id FROM push WHERE sus_id=? ORDER BY id DESC LIMIT 5)`, id, id);
  }
  quitarPush(endpoint) { this.sql.exec("DELETE FROM push WHERE endpoint=?", endpoint); }
  emailPendiente(id, email) {
    const cod = aleatorio(16);
    this.sql.exec("UPDATE suscriptores SET email_pend=?, email_cod=? WHERE id=?", email, cod, id);
    return cod;
  }
  confirmarEmail(id, cod) {
    const s = this.sql.exec("SELECT email_pend, email_cod FROM suscriptores WHERE id=?", id).toArray()[0];
    if (!s || !s.email_cod || s.email_cod !== cod) return false;
    this.sql.exec("UPDATE suscriptores SET email=email_pend, email_pend=NULL, email_cod=NULL WHERE id=?", id);
    return true;
  }
  quitarEmail(id) { this.sql.exec("UPDATE suscriptores SET email=NULL, email_pend=NULL, email_cod=NULL WHERE id=?", id); }
  ponerBase(id, base) { this.sql.exec("UPDATE suscriptores SET base=? WHERE id=? AND base IS NULL", base, id); }
  ponerNtfy(id, valor) { this.sql.exec("UPDATE suscriptores SET ntfy=? WHERE id=?", valor ? 1 : 0, id); }
  marcarAviso(id, cuando) { this.sql.exec("UPDATE suscriptores SET ultimo_aviso=? WHERE id=?", cuando, id); }
}

const almacen = (env) => env.ALMACEN.get(env.ALMACEN.idFromName("global"));

// ------------------------------------------------------------------ Meteorología
async function geocodificar(c, texto) {
  const u = new URL(c.geocodingUrl);
  u.search = new URLSearchParams({ name: texto, count: "6", language: "es" });
  const r = await fetch(u);
  if (!r.ok) throw new Error("geocoding " + r.status);
  const d = await r.json();
  return (d.results ?? []).map((x) => ({
    nombre: [x.name, x.admin2 || x.admin1, x.country].filter(Boolean).join(", "),
    lat: x.latitude, lon: x.longitude,
  }));
}

/** Pronóstico horario (ayer + 2 días) para una o varias ubicaciones en una sola consulta. */
async function pronosticos(c, puntos) {
  const u = new URL(c.forecastUrl);
  u.search = new URLSearchParams({
    latitude: puntos.map((p) => p.lat).join(","),
    longitude: puntos.map((p) => p.lon).join(","),
    hourly: "temperature_2m", past_days: "1", forecast_days: "2", timezone: "auto",
  });
  const r = await fetch(u);
  if (!r.ok) throw new Error("forecast " + r.status);
  const d = await r.json();
  return (Array.isArray(d) ? d : [d]).map((x) => ({
    tiempos: x.hourly.time,
    temps: x.hourly.temperature_2m,
    ahora: Date.now() + x.utc_offset_seconds * 1000, // hora local expresada como si fuera UTC
  }));
}

const clave = (ms) => new Date(ms).toISOString().slice(0, 16); // "2026-10-14T19:00", formato de Open-Meteo

/**
 * Para cada hora de las próximas 24 h compara la temperatura prevista con la de
 * la MISMA hora del día anterior. Así se neutraliza el ciclo día/noche y solo
 * cuenta como rebotá un cambio real de masa de aire (frentes, DANAs...).
 */
export function analizar({ tiempos, temps, ahora }) {
  const serie = new Map();
  tiempos.forEach((t, i) => { if (temps[i] != null) serie.set(t, temps[i]); });
  const inicio = Math.floor(ahora / H) * H;
  let peor = null;
  for (let h = 1; h <= 24; h++) {
    const t = inicio + h * H;
    const kt = clave(t), kr = clave(t - 24 * H);
    if (serie.has(kt) && serie.has(kr)) {
      const caida = serie.get(kr) - serie.get(kt);
      if (!peor || caida > peor.caida) peor = { caida, t, antes: serie.get(kr), despues: serie.get(kt) };
    }
  }
  return peor;
}

export function veredicto(peor, ahora, umbral) {
  if (!peor) return { si: null, titular: "No lo sé", detalle: "No hay datos de pronóstico suficientes para esta ubicación." };
  const { caida, t, antes, despues } = peor;
  const cuando = clave(t).slice(0, 10) > clave(ahora).slice(0, 10) ? "mañana" : "hoy";
  const momento = `${cuando} ${DIAS[new Date(t).getUTCDay()]} a las ${clave(t).slice(11, 13)}:00`;
  const r = (x) => Math.round(x);
  if (caida >= umbral) {
    return { si: true, titular: "Sí, va a dar la rebotá",
      detalle: `${momento[0].toUpperCase() + momento.slice(1)} se esperan ${r(despues)} °C: ${r(caida)} °C menos que a la misma hora del día anterior (${r(antes)} °C).` };
  }
  if (caida <= 0) {
    return { si: false, titular: "No, no va a dar la rebotá",
      detalle: "Las próximas 24 horas no van a ser más frías que las anteriores." };
  }
  return { si: false, titular: "No, no va a dar la rebotá",
    detalle: `La mayor bajada prevista es de ${r(caida)} °C (${momento}). Para que dé la rebotá tienen que ser ${umbral} °C o más.` };
}

// ------------------------------------------------------------------ Web Push (RFC 8291 + VAPID RFC 8292)
async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}

/** Cifra el mensaje para un navegador concreto (content-encoding aes128gcm). */
export async function cifrarPush(p256dh, authB64, texto) {
  const uaPub = deB64url(p256dh), auth = deB64url(authB64);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secreto = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, secreto, unir(enc.encode("WebPush: info\u0000"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\u0000"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\u0000"), 12);
  const clave = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce },
    clave, unir(enc.encode(texto), new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return unir(salt, rs, new Uint8Array([65]), asPub, cifrado);
}

async function jwtVapid(vapid, audiencia, sujeto) {
  const cab = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const cuerpo = b64url(enc.encode(JSON.stringify({ aud: audiencia, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: sujeto })));
  const k = await crypto.subtle.importKey("jwk", vapid.privada, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, enc.encode(`${cab}.${cuerpo}`));
  return `${cab}.${cuerpo}.${b64url(firma)}`;
}

/** Devuelve "ok", "caducada" (hay que borrarla) o "error". */
async function enviarPush(vapid, p, base, mensaje) {
  try {
    const cuerpo = await cifrarPush(p.p256dh, p.auth, JSON.stringify(mensaje));
    const jwt = await jwtVapid(vapid, new URL(p.endpoint).origin, base);
    const r = await fetch(p.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm",
        TTL: "43200", Urgency: "high",
        Authorization: `vapid t=${jwt}, k=${vapid.publica}`,
      },
      body: cuerpo,
    });
    if (r.status === 404 || r.status === 410) return "caducada";
    return r.ok ? "ok" : "error";
  } catch { return "error"; }
}

// ------------------------------------------------------------------ Correo y ntfy
async function enviarCorreo(c, para, asunto, texto, enlace, textoEnlace) {
  if (!c.correo) return false;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:auto;padding:16px;color:#1d2733">
<p style="font-weight:800;color:#5b6875">❄️ RebotApp</p>
<h2 style="margin:0 0 12px">${esc(asunto)}</h2><p style="font-size:16px;line-height:1.5">${esc(texto)}</p>
<p><a href="${esc(enlace)}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">${esc(textoEnlace)}</a></p>
<p style="font-size:13px;color:#5b6875">Recibes este correo porque activaste los avisos de RebotApp. Puedes cambiarlos o darte de baja en <a href="${esc(enlace)}">tu página de aviso</a>.</p></div>`;
  try {
    const r = await fetch(c.brevoUrl, {
      method: "POST",
      headers: { "api-key": c.brevoKey, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: c.remitenteNombre, email: c.remitente },
        to: [{ email: para }], subject: asunto, htmlContent: html,
        textContent: `${texto}\n\n${textoEnlace}: ${enlace}`,
      }),
    });
    return r.ok;
  } catch { return false; }
}

async function notificarNtfy(c, topic, title, message, priority = 4, tags = ["snowflake"]) {
  try {
    const r = await fetch(c.ntfy, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, title, message, priority, tags }),
    });
    return r.ok;
  } catch { return false; }
}

/** Envía un aviso por todos los canales activos del suscriptor. */
async function avisar(env, c, s, titulo, texto, presupuesto = { n: Infinity }) {
  const st = almacen(env);
  const base = s.base || "";
  const pagina = `${base}/s/${s.token}`;
  const res = { push: 0, correo: null, ntfy: null };
  if (s.push.length && presupuesto.n > 0) {
    const vapid = await st.vapid();
    for (const p of s.push) {
      if (presupuesto.n <= 0) break;
      presupuesto.n--;
      const r = await enviarPush(vapid, p, base || "https://rebotapp.workers.dev", { title: titulo, body: texto, url: pagina });
      if (r === "ok") res.push++;
      if (r === "caducada") await st.quitarPush(p.endpoint);
    }
  }
  if (s.email && c.correo && presupuesto.n > 0) {
    presupuesto.n--;
    res.correo = await enviarCorreo(c, s.email, titulo, texto, pagina, "Ver mi aviso");
  }
  if (s.ntfy && presupuesto.n > 0) {
    presupuesto.n--;
    res.ntfy = await notificarNtfy(c, s.topic, titulo, texto);
  }
  return res;
}

const tieneCanal = (s, c) => s.push.length > 0 || (s.email && c.correo) || s.ntfy;

/**
 * Revisa a todos los suscriptores. El plan gratuito permite 50 peticiones externas
 * por ejecución: los pronósticos se piden en lotes de 50 ubicaciones y, si no da
 * tiempo a avisar a todos, los pendientes se avisan en la ejecución de media hora después.
 */
async function revisarTodos(env) {
  const c = cfg(env);
  const st = almacen(env);
  const ahora = Date.now();
  const pendientes = (await st.todos()).filter((s) => tieneCanal(s, c) &&
    (!s.ultimo_aviso || ahora - s.ultimo_aviso >= c.silencio * H));
  const presupuesto = { n: 45 };
  const log = [];

  for (let i = 0; i < pendientes.length && presupuesto.n > 0; i += 50) {
    const lote = pendientes.slice(i, i + 50);
    presupuesto.n--;
    let datos;
    try { datos = await pronosticos(c, lote); } catch (e) { log.push("error pronóstico: " + e.message); continue; }
    for (let j = 0; j < lote.length; j++) {
      const s = lote[j];
      const v = veredicto(analizar(datos[j]), datos[j].ahora, c.umbral);
      if (!v.si) continue;
      if (presupuesto.n <= 0) { log.push(`${s.nombre}: aplazado`); continue; }
      const r = await avisar(env, c, s, `Va a dar la rebotá en ${s.nombre.split(",")[0]}`, v.detalle, presupuesto);
      if (r.push || r.correo || r.ntfy) await st.marcarAviso(s.id, Date.now());
      log.push(`${s.nombre}: AVISO ${JSON.stringify(r)} - ${v.detalle}`);
    }
  }
  console.log(`Revisión: ${pendientes.length} suscriptores revisables`, log);
  return log;
}

function horaLocal(ms, zona) {
  return parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: zona, hour: "2-digit", hourCycle: "h23" })
    .format(new Date(ms)), 10);
}

// ------------------------------------------------------------------ Web
function pagina(cuerpo, { status = 200, manifest = "/manifest.webmanifest" } = {}) {
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RebotApp — ¿Va a dar la rebotá?</title>
<link rel="manifest" href="${esc(manifest)}">
<link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="RebotApp">
<meta name="theme-color" content="#2563eb">
<style>
 :root{--bg:#f4f6f8;--card:#fff;--txt:#1d2733;--sub:#5b6875;--acc:#2563eb;--line:#dde3ea;
       --si:#1d4ed8;--si-bg:#e0eaff;--no:#15803d;--no-bg:#e3f6ea;--ok:#15803d;--warn-bg:#fff7e0}
 @media (prefers-color-scheme:dark){:root{--bg:#10151b;--card:#18212b;--txt:#e6edf3;--sub:#9aa7b4;--acc:#60a5fa;--line:#2a3542;
       --si:#93b4ff;--si-bg:#1b2a4a;--no:#6ee7a0;--no-bg:#16352a;--ok:#6ee7a0;--warn-bg:#3a3018}}
 *{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--txt)}
 main{max-width:520px;margin:0 auto;padding:32px 16px}
 .marca{display:inline-flex;align-items:center;gap:8px;font-weight:800;letter-spacing:-.02em;font-size:1.05rem;color:var(--sub);margin:0 0 16px;text-decoration:none}
 .marca img{width:24px;height:24px;border-radius:6px}
 .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:16px}
 h1{font-size:1.7rem;line-height:1.2;margin:0 0 6px}h2{font-size:1.15rem;margin:0 0 6px}p.sub{color:var(--sub);margin:0 0 16px}
 input[type=text],input[type=email]{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:1rem;background:var(--bg);color:var(--txt)}
 button,.btn{display:inline-block;margin-top:12px;padding:11px 18px;border:0;border-radius:10px;background:var(--acc);color:#fff;font-size:1rem;cursor:pointer;text-decoration:none}
 button:disabled{opacity:.5;cursor:default}
 .sec{background:transparent;border:1px solid var(--line);color:var(--txt)}
 .opt{display:block;width:100%;text-align:left;background:var(--bg);color:var(--txt);border:1px solid var(--line)}
 .resp{border-radius:14px;padding:28px 24px;margin-bottom:16px;text-align:center}
 .resp.si{background:var(--si-bg);color:var(--si)}.resp.no{background:var(--no-bg);color:var(--no)}
 .resp .big{font-size:2rem;font-weight:800;line-height:1.15;margin:6px 0 10px}
 .resp .det{color:var(--txt);margin:0}.resp .lugar{font-size:.9rem;opacity:.85}
 .estado{font-weight:600;color:var(--ok)}.aviso{background:var(--warn-bg);border-radius:10px;padding:12px 14px;margin-top:12px;font-size:.95rem}
 .canal+.canal{border-top:1px solid var(--line);margin-top:20px;padding-top:20px}
 details summary{cursor:pointer;color:var(--sub)}
 code{background:var(--bg);padding:2px 6px;border-radius:6px;word-break:break-all}
 small{color:var(--sub)}[hidden]{display:none!important}
 .pie{color:var(--sub);font-size:.85rem;margin:24px 4px 0;line-height:1.45}
</style></head><body><main>
<a class="marca" href="/"><img src="/icon-192.png" alt="">RebotApp</a>
${cuerpo}
<p class="pie">* El concepto «rebotá» fue acuñado originalmente por Julio Gómez Medina. Esta aplicación resucita su idea para darle vigencia y utilidad.</p>
</main></body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const textoHoras = (c) => c.horas.join(" y ");
const enlaceConsulta = (lat, lon, nombre) => "/consulta?" + new URLSearchParams({ lat, lon, nombre }).toString();

function coordenadas(p) {
  const lat = parseFloat(p.get("lat")), lon = parseFloat(p.get("lon"));
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return { lat, lon, nombre: (p.get("nombre") || "Tu ubicación").slice(0, 120) };
}

const error400 = () => pagina('<div class="card"><h1>Ubicación no válida</h1><a class="btn sec" href="/">Volver</a></div>', { status: 400 });
const error404 = () => pagina('<div class="card"><h1>No encontrado</h1><p>Este aviso no existe o ya se dio de baja.</p><a class="btn sec" href="/">Volver a RebotApp</a></div>', { status: 404 });

function inicio(c) {
  return pagina(`
<div class="card">
 <h1>¿Va a dar la rebotá*?</h1>
 <p class="sub">Dinos dónde estás y te decimos si en las próximas 24 horas la temperatura va a caer ${c.umbral} °C o más respecto al día anterior.</p>
 <form method="post" action="/buscar">
  <input type="text" name="q" placeholder="Tu localidad (p. ej. Las Rozas)" required>
  <button>Buscar</button>
 </form>
 <form method="get" action="/consulta" id="geo">
  <input type="hidden" name="lat"><input type="hidden" name="lon">
  <input type="hidden" name="nombre" value="Tu ubicación">
  <button type="button" class="sec" onclick="usarUbicacion()">📍 Usar mi ubicación actual</button>
 </form>
 <p id="mio" hidden><a class="btn sec" href="#">🔔 Mi aviso</a></p>
</div>
<script>
function usarUbicacion(){
  if(!navigator.geolocation){alert('Tu navegador no permite la geolocalización');return;}
  navigator.geolocation.getCurrentPosition(p=>{
    const f=document.getElementById('geo');
    f.lat.value=p.coords.latitude.toFixed(4);f.lon.value=p.coords.longitude.toFixed(4);f.submit();
  },()=>alert('No se pudo obtener la ubicación'));
}
try{const t=localStorage.getItem('rebotapp_token');if(t){const m=document.getElementById('mio');m.hidden=false;m.firstChild.href='/s/'+t;}}catch(e){}
</script>`);
}

async function buscar(c, req) {
  const q = ((await req.formData()).get("q") || "").trim();
  let res;
  try { res = q ? await geocodificar(c, q) : []; } catch { res = null; }
  const lista = res === null ? "<p>No se pudo consultar el buscador. Inténtalo de nuevo en un momento.</p>"
    : !res.length ? `<p>No he encontrado «${esc(q)}».</p>`
    : res.map((r) => `<a class="btn opt" href="${esc(enlaceConsulta(r.lat, r.lon, r.nombre))}">${esc(r.nombre)}</a>`).join("\n");
  return pagina(`<div class="card"><h1>¿Dónde exactamente?</h1>${lista}<a class="btn sec" href="/">Volver</a></div>`);
}

async function consulta(c, url) {
  const p = coordenadas(url.searchParams);
  if (!p) return error400();
  let v;
  try {
    const [d] = await pronosticos(c, [p]);
    v = veredicto(analizar(d), d.ahora, c.umbral);
  } catch {
    v = { si: null, titular: "No lo sé", detalle: "No se pudo consultar el pronóstico. Inténtalo de nuevo en un momento." };
  }
  return pagina(`
<div class="resp ${v.si ? "si" : "no"}">
 <div class="lugar">¿Va a dar la rebotá en ${esc(p.nombre)}?</div>
 <div class="big">${esc(v.titular)}</div>
 <p class="det">${esc(v.detalle)}</p>
</div>
<div class="card">
 <h2>Que te avise RebotApp</h2>
 <p class="sub">Revisamos el pronóstico a las ${textoHoras(c)} h y te avisamos cuando vaya a dar la rebotá aquí: con una notificación en el móvil${c.correo ? " o por correo" : ""}.</p>
 <form method="post" action="/alta">
  <input type="hidden" name="lat" value="${p.lat}"><input type="hidden" name="lon" value="${p.lon}">
  <input type="hidden" name="nombre" value="${esc(p.nombre)}">
  <button>🔔 Avísame</button>
 </form>
 <a class="btn sec" href="/">Consultar otro sitio</a>
</div>`);
}

async function alta(env, req) {
  const p = coordenadas(await req.formData());
  if (!p) return error400();
  const token = await almacen(env).alta(p.nombre, p.lat, p.lon, new URL(req.url).origin);
  return Response.redirect(new URL("/s/" + token, req.url).toString(), 303);
}

async function paginaAviso(env, c, s, mensaje = "") {
  const vapid = await almacen(env).vapid();
  const n = s.push.length;
  const lugar = s.nombre.split(",")[0];
  return pagina(`
${mensaje ? `<div class="card">${mensaje}</div>` : ""}
<div class="card">
 <h1>🔔 Tu aviso</h1>
 <p class="sub">${esc(s.nombre)} · revisamos a las ${textoHoras(c)} h</p>

 <div class="canal">
  <h2>Notificaciones en este móvil u ordenador</h2>
  <p id="pushEstado" class="${n ? "estado" : "sub"}">${n ? `Activadas en ${n} dispositivo${n > 1 ? "s" : ""}.` : "Sin activar."}</p>
  <div id="iosAviso" class="aviso" hidden>
   <b>En iPhone, un paso antes:</b> pulsa el botón <b>Compartir</b> de Safari (el cuadrado con la flecha hacia arriba) →
   <b>Añadir a pantalla de inicio</b>. Abre RebotApp desde ese icono nuevo y pulsa aquí «Activar notificaciones».
  </div>
  <p id="noSoporte" class="aviso" hidden>Este navegador no admite notificaciones. Prueba con Chrome, Edge o Firefox${c.correo ? ", o usa el correo" : ""}.</p>
  <button id="btnPush" type="button" onclick="activarPush()">Activar notificaciones aquí</button>
 </div>

 ${c.correo ? `<div class="canal">
  <h2>Correo electrónico</h2>
  ${s.email ? `<p class="estado">Activado: ${esc(s.email)}</p>
   <form method="post" action="/s/${s.token}/email/quitar"><button class="sec">Quitar correo</button></form>`
  : `${s.email_pend ? `<p class="aviso">Te hemos enviado un correo a <b>${esc(s.email_pend)}</b>. Pulsa el enlace de confirmación (mira también en spam).</p>` : ""}
   <form method="post" action="/s/${s.token}/email">
    <input type="email" name="email" placeholder="tu@correo.com" required>
    <button>${s.email_pend ? "Enviar de nuevo" : "Avisarme por correo"}</button>
   </form>
   <small>Solo usamos tu correo para avisarte de la rebotá. Puedes quitarlo cuando quieras.</small>`}
 </div>` : ""}

 <div class="canal">
  <details ${s.ntfy ? "open" : ""}>
   <summary>¿Usas la app ntfy?</summary>
   ${s.ntfy ? `<p class="estado">Activado. Canal: <code>${esc(s.topic)}</code></p>
    <form method="post" action="/s/${s.token}/ntfy"><input type="hidden" name="v" value="0"><button class="sec">Desactivar ntfy</button></form>`
   : `<p class="sub">Si tienes la app ntfy, también podemos avisarte por ahí.</p>
    <form method="post" action="/s/${s.token}/ntfy"><input type="hidden" name="v" value="1"><button class="sec">Usar ntfy</button></form>`}
  </details>
 </div>
</div>

<div class="card">
 <form method="post" action="/s/${s.token}/prueba" style="display:inline"><button>Enviar aviso de prueba</button></form>
 <a class="btn sec" href="${esc(enlaceConsulta(s.lat, s.lon, s.nombre))}">¿Va a dar hoy?</a>
 <p><small>Guarda esta página en favoritos: desde aquí gestionas tu aviso de ${esc(lugar)}.</small></p>
 <form method="post" action="/s/${s.token}/baja" onsubmit="return confirm('¿Eliminar este aviso?')"><button class="sec">Darme de baja</button></form>
</div>

<script>
const TOKEN=${JSON.stringify(s.token)}, VAPID=${JSON.stringify(vapid.publica)};
try{localStorage.setItem('rebotapp_token',TOKEN);}catch(e){}
const $=id=>document.getElementById(id);
const ios=/iPhone|iPad|iPod/.test(navigator.userAgent);
const instalada=navigator.standalone||matchMedia('(display-mode: standalone)').matches;
const soporta='serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
function clave(b){const p='='.repeat((4-b.length%4)%4),s=atob((b+p).replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(s,c=>c.charCodeAt(0));}
async function estado(){
  if(!soporta){ if(ios&&!instalada) $('iosAviso').hidden=false; else $('noSoporte').hidden=false; $('btnPush').hidden=true; return; }
  const reg=await navigator.serviceWorker.getRegistration('/');
  const sub=reg&&await reg.pushManager.getSubscription();
  if(sub&&Notification.permission==='granted'){ $('btnPush').textContent='Activadas en este dispositivo ✓'; $('btnPush').disabled=true; }
}
async function activarPush(){
  const b=$('btnPush'); b.disabled=true; b.textContent='Activando…';
  try{
    if(await Notification.requestPermission()!=='granted'){ alert('Has bloqueado las notificaciones. Actívalas en los ajustes del navegador para esta web.'); b.disabled=false; b.textContent='Activar notificaciones aquí'; return; }
    const reg=await navigator.serviceWorker.register('/sw.js',{scope:'/'}); await navigator.serviceWorker.ready;
    let sub=await reg.pushManager.getSubscription();
    if(!sub) sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:clave(VAPID)});
    const r=await fetch('/s/'+TOKEN+'/push',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sub)});
    if(!r.ok) throw new Error();
    location.reload();
  }catch(e){ alert('No se pudieron activar las notificaciones en este navegador.'); b.disabled=false; b.textContent='Activar notificaciones aquí'; }
}
estado();
</script>`, { manifest: `/s/${s.token}/manifest.webmanifest` });
}

function manifest(inicioUrl) {
  return new Response(JSON.stringify({
    name: "RebotApp", short_name: "RebotApp", description: "¿Va a dar la rebotá?",
    start_url: inicioUrl, scope: "/", display: "standalone",
    background_color: "#2563eb", theme_color: "#2563eb", lang: "es",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  }), { headers: { "Content-Type": "application/manifest+json" } });
}

const SW = `self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{};}catch(_){d={body:e.data&&e.data.text()};}
  e.waitUntil(self.registration.showNotification(d.title||'RebotApp',{body:d.body||'',icon:'/icon-192.png',badge:'/icon-192.png',tag:'rebota',renotify:true,data:{url:d.url||'/'}}));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(ws=>{
    for(const w of ws){if('focus' in w){w.navigate(e.notification.data.url);return w.focus();}}
    return self.clients.openWindow(e.notification.data.url);
  }));
});`;

function png(b64) {
  return new Response(Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0)),
    { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800" } });
}

// ------------------------------------------------------------------ Gestión del aviso
async function rutasAviso(env, c, req, token, accion) {
  const st = almacen(env);
  const s = await st.porToken(token);
  if (!s) return error404();
  const volver = () => Response.redirect(new URL("/s/" + token, req.url).toString(), 303);
  const metodo = req.method;

  if (!s.base) { s.base = new URL(req.url).origin; await st.ponerBase(s.id, s.base); } // avisos antiguos
  if (metodo === "GET" && !accion) return paginaAviso(env, c, s);
  if (metodo === "GET" && accion === "manifest.webmanifest") return manifest("/s/" + token);

  if (metodo === "POST" && accion === "push") {
    let sub;
    try { sub = await req.json(); } catch { return new Response("JSON no válido", { status: 400 }); }
    const ep = sub?.endpoint, k = sub?.keys;
    if (typeof ep !== "string" || !(ep.startsWith("https://") || env.PUSH_HTTP_OK === "1") || ep.length > 1000 || !k?.p256dh || !k?.auth)
      return new Response("Suscripción no válida", { status: 400 });
    await st.guardarPush(s.id, ep, String(k.p256dh), String(k.auth));
    return new Response("ok");
  }

  if (metodo === "POST" && accion === "email" && c.correo) {
    const email = String((await req.formData()).get("email") || "").trim().toLowerCase();
    if (!emailValido(email)) return paginaAviso(env, c, s, '<p class="aviso">Esa dirección de correo no parece válida.</p>');
    const cod = await st.emailPendiente(s.id, email);
    const enlace = `${new URL(req.url).origin}/s/${token}/confirmar?c=${cod}`;
    const ok = await enviarCorreo(c, email, "Confirma tus avisos de RebotApp",
      `Pulsa el botón para recibir en este correo los avisos de cuándo va a dar la rebotá en ${s.nombre.split(",")[0]}. Si no lo has pedido tú, ignora este mensaje.`,
      enlace, "Confirmar correo");
    if (!ok) return paginaAviso(env, c, s, '<p class="aviso">No se pudo enviar el correo de confirmación. Inténtalo más tarde.</p>');
    return volver();
  }
  if (metodo === "GET" && accion === "confirmar") {
    const ok = await st.confirmarEmail(s.id, new URL(req.url).searchParams.get("c") || "");
    return paginaAviso(env, c, await st.porToken(token), ok
      ? '<p class="estado">✅ Correo confirmado. Te avisaremos ahí cuando vaya a dar la rebotá.</p>'
      : '<p class="aviso">Este enlace de confirmación ya no es válido.</p>');
  }
  if (metodo === "POST" && accion === "email/quitar") { await st.quitarEmail(s.id); return volver(); }
  if (metodo === "POST" && accion === "ntfy") { await st.ponerNtfy(s.id, (await req.formData()).get("v") === "1"); return volver(); }

  if (metodo === "POST" && accion === "prueba") {
    if (!tieneCanal(s, c))
      return paginaAviso(env, c, s, '<p class="aviso">Primero activa las notificaciones' + (c.correo ? " o el correo" : "") + ".</p>");
    const r = await avisar(env, c, s, "RebotApp funciona",
      `Te avisaremos cuando vaya a dar la rebotá en ${s.nombre.split(",")[0]}.`);
    const partes = [];
    if (s.push.length) partes.push(`Notificación: ${r.push ? `enviada a ${r.push} dispositivo${r.push > 1 ? "s" : ""}` : "no se pudo enviar"}`);
    if (s.email && c.correo) partes.push(`Correo: ${r.correo ? "enviado" : "no se pudo enviar"}`);
    if (s.ntfy) partes.push(`ntfy: ${r.ntfy ? "enviado" : "no se pudo enviar"}`);
    return paginaAviso(env, c, await st.porToken(token), `<h2>Aviso de prueba</h2><p>${partes.map(esc).join("<br>")}</p>`);
  }

  if (metodo === "POST" && accion === "baja") {
    await st.baja(s.id);
    return pagina(`<div class="card"><h1>Aviso eliminado</h1><a class="btn sec" href="/">Volver a RebotApp</a></div>
<script>try{localStorage.removeItem('rebotapp_token');}catch(e){}
navigator.serviceWorker&&navigator.serviceWorker.getRegistration('/').then(r=>r&&r.pushManager.getSubscription()).then(s=>s&&s.unsubscribe()).catch(()=>{});</script>`);
  }
  return error404();
}

// ------------------------------------------------------------------ Entrada
export default {
  async fetch(req, env) {
    const c = cfg(env);
    const url = new URL(req.url);
    const ruta = url.pathname;

    if (req.method === "GET") {
      if (ruta === "/") return inicio(c);
      if (ruta === "/consulta") return consulta(c, url);
      if (ruta === "/sw.js") return new Response(SW, { headers: { "Content-Type": "text/javascript", "Cache-Control": "no-cache" } });
      if (ruta === "/manifest.webmanifest") return manifest("/");
      if (ruta === "/icon-192.png" || ruta === "/apple-touch-icon.png" || ruta === "/favicon.ico") return png(ICON_192);
      if (ruta === "/icon-512.png") return png(ICON_512);
    }
    if (req.method === "POST" && ruta === "/buscar") return buscar(c, req);
    if (req.method === "POST" && ruta === "/alta") return alta(env, req);

    const m = ruta.match(/^\/s\/([\w-]{10,40})(?:\/(push|email|email\/quitar|confirmar|ntfy|prueba|baja|manifest\.webmanifest))?$/);
    if (m) return rutasAviso(env, c, req, m[1], m[2]);
    return error404();
  },

  async scheduled(event, env, ctx) {
    const c = cfg(env);
    // Cloudflare programa en UTC: se ejecuta cada 30 min y solo actúa a las horas
    // locales indicadas (así respeta el cambio de hora verano/invierno).
    if (env.REVISAR_SIEMPRE !== "1" && !c.horas.includes(horaLocal(event.scheduledTime, c.zona))) return;
    ctx.waitUntil(revisarTodos(env));
  },
};
