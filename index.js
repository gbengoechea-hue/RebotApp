/**
 * RebotApp — ¿Va a dar la rebotá?
 *
 * La "rebotá" es una caída brusca de la temperatura: que en las próximas 24 horas
 * alguna hora vaya a estar UMBRAL_C grados (8 por defecto) o más por debajo de la
 * misma hora del día anterior.
 *
 * Cloudflare Worker (plan gratuito):
 *  - fetch():      la web (consulta + alta/baja de avisos)
 *  - scheduled():  se ejecuta cada 30 min y, a las HORAS_REVISION de ZONA,
 *                  revisa a los suscriptores y les avisa por ntfy
 *  - Almacen:      Durable Object con SQLite donde se guardan las suscripciones
 *
 * Pronóstico: Open-Meteo (gratuito, sin clave). Avisos: ntfy (app gratuita).
 */
import { DurableObject } from "cloudflare:workers";

const H = 3600 * 1000;
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function cfg(env) {
  return {
    umbral: parseFloat(env.UMBRAL_C ?? "8"),
    horas: (env.HORAS_REVISION ?? "8,20").split(",").map((h) => parseInt(h, 10)),
    zona: env.ZONA ?? "Europe/Madrid",
    silencio: parseInt(env.HORAS_ENTRE_AVISOS ?? "18", 10),
    ntfy: (env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/$/, ""),
    forecastUrl: env.FORECAST_URL ?? "https://api.open-meteo.com/v1/forecast",
    geocodingUrl: env.GEOCODING_URL ?? "https://geocoding-api.open-meteo.com/v1/search",
  };
}

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
  }
  alta(nombre, lat, lon) {
    const topic = "rebota-" + aleatorio(12);
    const token = aleatorio(16);
    this.sql.exec("INSERT INTO suscriptores (nombre,lat,lon,topic,token,creado) VALUES (?,?,?,?,?,?)",
      nombre, lat, lon, topic, token, Date.now());
    return token;
  }
  porToken(token) {
    return this.sql.exec("SELECT * FROM suscriptores WHERE token=?", token).toArray()[0] ?? null;
  }
  baja(token) {
    this.sql.exec("DELETE FROM suscriptores WHERE token=?", token);
  }
  todos() {
    return this.sql.exec("SELECT * FROM suscriptores").toArray();
  }
  marcarAviso(id, cuando) {
    this.sql.exec("UPDATE suscriptores SET ultimo_aviso=? WHERE id=?", cuando, id);
  }
}

const almacen = (env) => env.ALMACEN.get(env.ALMACEN.idFromName("global"));

function aleatorio(bytes) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
    ahora: Date.now() + x.utc_offset_seconds * 1000, // "hora local" expresada como si fuera UTC
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

// ------------------------------------------------------------------ Avisos
async function notificar(c, topic, title, message, priority = 4, tags = ["snowflake"]) {
  const r = await fetch(c.ntfy, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic, title, message, priority, tags }),
  });
  if (!r.ok) throw new Error("ntfy " + r.status);
}

/**
 * Revisa a todos los suscriptores. El plan gratuito permite 50 peticiones externas
 * por ejecución: se piden los pronósticos en lotes de 50 ubicaciones y, si no da
 * tiempo a avisar a todos, los pendientes se avisan en la ejecución de media hora después.
 */
async function revisarTodos(env) {
  const c = cfg(env);
  const st = almacen(env);
  const ahora = Date.now();
  const pendientes = (await st.todos()).filter(
    (s) => !s.ultimo_aviso || ahora - s.ultimo_aviso >= c.silencio * H);
  let presupuesto = 45;
  const log = [];

  for (let i = 0; i < pendientes.length && presupuesto > 0; i += 50) {
    const lote = pendientes.slice(i, i + 50);
    presupuesto--;
    let datos;
    try { datos = await pronosticos(c, lote); } catch (e) { log.push("error pronóstico: " + e.message); continue; }
    for (let j = 0; j < lote.length; j++) {
      const s = lote[j];
      const v = veredicto(analizar(datos[j]), datos[j].ahora, c.umbral);
      if (!v.si) continue;
      if (presupuesto <= 0) { log.push(`${s.nombre}: aplazado`); continue; }
      presupuesto--;
      try {
        await notificar(c, s.topic, `Va a dar la rebotá en ${s.nombre.split(",")[0]}`, v.detalle);
        await st.marcarAviso(s.id, Date.now());
        log.push(`${s.nombre}: AVISO - ${v.detalle}`);
      } catch (e) { log.push(`${s.nombre}: error aviso ${e.message}`); }
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
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

function pagina(cuerpo, status = 200) {
  return new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>RebotApp — ¿Va a dar la rebotá?</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>❄️</text></svg>">
<style>
 :root{--bg:#f4f6f8;--card:#fff;--txt:#1d2733;--sub:#5b6875;--acc:#2563eb;--line:#dde3ea;
       --si:#1d4ed8;--si-bg:#e0eaff;--no:#15803d;--no-bg:#e3f6ea}
 @media (prefers-color-scheme:dark){:root{--bg:#10151b;--card:#18212b;--txt:#e6edf3;--sub:#9aa7b4;--acc:#60a5fa;--line:#2a3542;
       --si:#93b4ff;--si-bg:#1b2a4a;--no:#6ee7a0;--no-bg:#16352a}}
 *{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--txt)}
 main{max-width:520px;margin:0 auto;padding:32px 16px}
 .marca{font-weight:800;letter-spacing:-.02em;font-size:1.05rem;color:var(--sub);margin:0 0 16px;text-decoration:none;display:inline-block}
 .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;margin-bottom:16px}
 h1{font-size:1.7rem;line-height:1.2;margin:0 0 6px}p.sub{color:var(--sub);margin:0 0 20px}
 input[type=text]{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;font-size:1rem;background:var(--bg);color:var(--txt)}
 button,.btn{display:inline-block;margin-top:12px;padding:11px 18px;border:0;border-radius:10px;background:var(--acc);color:#fff;font-size:1rem;cursor:pointer;text-decoration:none}
 .sec{background:transparent;border:1px solid var(--line);color:var(--txt)}
 .opt{display:block;width:100%;text-align:left;background:var(--bg);color:var(--txt);border:1px solid var(--line)}
 .resp{border-radius:14px;padding:28px 24px;margin-bottom:16px;text-align:center}
 .resp.si{background:var(--si-bg);color:var(--si)}.resp.no{background:var(--no-bg);color:var(--no)}
 .resp .big{font-size:2rem;font-weight:800;line-height:1.15;margin:6px 0 10px}
 .resp .det{color:var(--txt);margin:0}.resp .lugar{font-size:.9rem;opacity:.85}
 code{background:var(--bg);padding:2px 6px;border-radius:6px;word-break:break-all}
 ol{padding-left:20px}li{margin-bottom:8px}small{color:var(--sub)}
</style></head><body><main>
<a class="marca" href="/">❄️ RebotApp</a>
${cuerpo}</main></body></html>`, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const textoHoras = (c) => c.horas.join(" y ");
const enlaceConsulta = (lat, lon, nombre) =>
  "/consulta?" + new URLSearchParams({ lat, lon, nombre }).toString();

function coordenadas(p) {
  const lat = parseFloat(p.get("lat")), lon = parseFloat(p.get("lon"));
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return { lat, lon, nombre: (p.get("nombre") || "Tu ubicación").slice(0, 120) };
}

const error400 = () => pagina('<div class="card"><h1>Ubicación no válida</h1><a class="btn sec" href="/">Volver</a></div>', 400);
const error404 = () => pagina('<div class="card"><h1>No encontrado</h1><p>Este aviso no existe o ya se dio de baja.</p><a class="btn sec" href="/">Volver a RebotApp</a></div>', 404);

function inicio(c) {
  return pagina(`
<div class="card">
 <h1>¿Va a dar la rebotá?</h1>
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
</div>
<script>
function usarUbicacion(){
  if(!navigator.geolocation){alert('Tu navegador no permite la geolocalización');return;}
  navigator.geolocation.getCurrentPosition(p=>{
    const f=document.getElementById('geo');
    f.lat.value=p.coords.latitude.toFixed(4);f.lon.value=p.coords.longitude.toFixed(4);f.submit();
  },()=>alert('No se pudo obtener la ubicación'));
}
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
 <h1 style="font-size:1.25rem">Que te avise RebotApp</h1>
 <p class="sub">Revisamos el pronóstico a las ${textoHoras(c)} h y te mandamos una notificación al móvil cuando vaya a dar la rebotá aquí.</p>
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
  const token = await almacen(env).alta(p.nombre, p.lat, p.lon);
  return Response.redirect(new URL("/s/" + token, req.url).toString(), 303);
}

function paginaAviso(c, s) {
  return pagina(`
<div class="card">
 <h1>✅ Aviso activado</h1>
 <p class="sub">${esc(s.nombre)}</p>
 <ol>
  <li>Instala la app gratuita <b>ntfy</b> (Android o iPhone).</li>
  <li>Pulsa <b>+</b> y suscríbete a este canal:<br><code>${esc(s.topic)}</code></li>
  <li>Comprueba que funciona: <form method="post" action="/s/${esc(s.token)}/prueba" style="display:inline">
      <button>Enviar notificación de prueba</button></form></li>
 </ol>
 <p><a class="btn sec" href="${esc(c.ntfy)}/${esc(s.topic)}" target="_blank">Abrir el canal en el navegador</a>
    <a class="btn sec" href="${esc(enlaceConsulta(s.lat, s.lon, s.nombre))}">¿Va a dar hoy?</a></p>
 <small>Guarda esta página: es tu enlace para gestionar el aviso. RebotApp revisa el pronóstico a las ${textoHoras(c)} h.</small>
</div>
<div class="card">
 <form method="post" action="/s/${esc(s.token)}/baja" onsubmit="return confirm('¿Desactivar el aviso?')">
  <button class="sec">Darme de baja</button>
 </form>
</div>`);
}

// ------------------------------------------------------------------ Entrada
export default {
  async fetch(req, env) {
    const c = cfg(env);
    const url = new URL(req.url);
    const ruta = url.pathname;
    const m = ruta.match(/^\/s\/([\w-]+)(\/(prueba|baja))?$/);

    if (req.method === "GET" && ruta === "/") return inicio(c);
    if (req.method === "POST" && ruta === "/buscar") return buscar(c, req);
    if (req.method === "GET" && ruta === "/consulta") return consulta(c, url);
    if (req.method === "POST" && ruta === "/alta") return alta(env, req);

    if (m) {
      const st = almacen(env);
      const s = await st.porToken(m[1]);
      if (!s) return error404();
      if (req.method === "GET" && !m[3]) return paginaAviso(c, s);
      if (req.method === "POST" && m[3] === "prueba") {
        try {
          await notificar(c, s.topic, "RebotApp funciona",
            `Te avisaré cuando vaya a dar la rebotá en ${s.nombre.split(",")[0]}.`, 3, ["white_check_mark"]);
        } catch {}
        return Response.redirect(new URL("/s/" + s.token, req.url).toString(), 303);
      }
      if (req.method === "POST" && m[3] === "baja") {
        await st.baja(s.token);
        return pagina('<div class="card"><h1>Aviso desactivado</h1><a class="btn sec" href="/">Volver a RebotApp</a></div>');
      }
    }
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
