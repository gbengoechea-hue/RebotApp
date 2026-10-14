"""
RebotApp — ¿Va a dar la rebotá?

La "rebotá" es una caída brusca de la temperatura: que en las próximas 24 horas
alguna hora vaya a estar UMBRAL_C grados (8 por defecto) o más por debajo de la
misma hora del día anterior.

Quien tenga el enlace indica su ubicación, ve al momento si va a dar la rebotá
y puede suscribirse para recibir un aviso en el móvil (vía ntfy) cuando vaya a dar.

Datos meteorológicos: Open-Meteo (gratuito, sin clave).
Notificaciones: ntfy (app gratuita para Android/iOS, sin cuenta).

Uso:
    python app.py            -> arranca la web + el programador (8:00 y 20:00)
    python app.py revisar    -> revisa todos los suscriptores una vez y sale
"""
import os
import sqlite3
import secrets
import sys
from datetime import datetime, timedelta, timezone

import requests
from flask import Flask, request, render_template_string, redirect, url_for, abort

# ---------------------------------------------------------------- Config
DB_PATH = os.environ.get("DB_PATH", "alertas.db")
NTFY_SERVER = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
UMBRAL_C = float(os.environ.get("UMBRAL_C", "8"))
HORAS_REVISION = os.environ.get("HORAS_REVISION", "8,20")
ZONA_PROGRAMADOR = os.environ.get("ZONA_PROGRAMADOR", "Europe/Madrid")
HORAS_ENTRE_AVISOS = int(os.environ.get("HORAS_ENTRE_AVISOS", "18"))  # evita repetir el mismo aviso
ACTIVAR_PROGRAMADOR = os.environ.get("ACTIVAR_PROGRAMADOR", "1") == "1"

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"

app = Flask(__name__)


# ---------------------------------------------------------------- Base de datos
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with db() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS suscriptores (
                id INTEGER PRIMARY KEY,
                nombre TEXT NOT NULL,
                lat REAL NOT NULL,
                lon REAL NOT NULL,
                topic TEXT UNIQUE NOT NULL,
                token TEXT UNIQUE NOT NULL,
                ultimo_aviso TEXT,
                creado TEXT NOT NULL
            )""")


# ---------------------------------------------------------------- Meteorología
def geocodificar(texto):
    r = requests.get(GEOCODING_URL, params={"name": texto, "count": 6, "language": "es"}, timeout=15)
    r.raise_for_status()
    resultados = []
    for x in r.json().get("results", []):
        partes = [x.get("name"), x.get("admin2") or x.get("admin1"), x.get("country")]
        resultados.append({
            "nombre": ", ".join(p for p in partes if p),
            "lat": x["latitude"],
            "lon": x["longitude"],
        })
    return resultados


def pronostico(lat, lon):
    """Temperatura horaria de las últimas 24 h y las próximas 48 h, en hora local del punto."""
    r = requests.get(FORECAST_URL, params={
        "latitude": lat, "longitude": lon,
        "hourly": "temperature_2m",
        "past_days": 1, "forecast_days": 2,
        "timezone": "auto",
    }, timeout=20)
    r.raise_for_status()
    d = r.json()
    ahora_local = datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(seconds=d["utc_offset_seconds"])
    return d["hourly"]["time"], d["hourly"]["temperature_2m"], ahora_local


def analizar(tiempos, temps, ahora):
    """
    Para cada hora de las próximas 24 h compara la temperatura prevista con la
    de la MISMA hora del día anterior. Así se neutraliza el ciclo día/noche
    (en Madrid es normal bajar 12-15 °C de la tarde a la madrugada) y solo
    cuenta como rebotá un cambio de masa de aire real: frentes fríos, DANAs, etc.

    Devuelve (caida, hora, temp_antes, temp_despues) de la peor hora, o None.
    """
    serie = {datetime.fromisoformat(t): v for t, v in zip(tiempos, temps) if v is not None}
    inicio = ahora.replace(minute=0, second=0, microsecond=0)
    peor = None
    for h in range(1, 25):
        t = inicio + timedelta(hours=h)
        ref = t - timedelta(hours=24)
        if t in serie and ref in serie:
            caida = serie[ref] - serie[t]
            if peor is None or caida > peor[0]:
                peor = (caida, t, serie[ref], serie[t])
    return peor


DIAS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"]


def veredicto(peor, ahora):
    """Respuesta a «¿Va a dar la rebotá?»: (si_o_no, titular, detalle)."""
    if not peor:
        return None, "No lo sé", "No hay datos de pronóstico suficientes para esta ubicación."
    caida, t, antes, despues = peor
    cuando = "mañana" if t.date() > ahora.date() else "hoy"
    momento = f"{cuando} {DIAS[t.weekday()]} a las {t:%H}:00"
    if caida >= UMBRAL_C:
        return True, "Sí, va a dar la rebotá", (
            f"{momento.capitalize()} se esperan {despues:.0f} °C: "
            f"{caida:.0f} °C menos que a la misma hora del día anterior ({antes:.0f} °C).")
    if caida <= 0:
        return False, "No, no va a dar la rebotá", (
            "Las próximas 24 horas no van a ser más frías que las anteriores.")
    return False, "No, no va a dar la rebotá", (
        f"La mayor bajada prevista es de {caida:.0f} °C ({momento}). "
        f"Para que dé la rebotá tienen que ser {UMBRAL_C:g} °C o más.")


# ---------------------------------------------------------------- Notificaciones
def notificar(topic, titulo, mensaje, prioridad=4, tags=("snowflake",)):
    r = requests.post(NTFY_SERVER, json={
        "topic": topic, "title": titulo, "message": mensaje,
        "priority": prioridad, "tags": list(tags),
    }, timeout=15)
    r.raise_for_status()


def revisar(sus, forzar=False):
    tiempos, temps, ahora = pronostico(sus["lat"], sus["lon"])
    peor = analizar(tiempos, temps, ahora)
    si, _, detalle = veredicto(peor, ahora)
    if not si:
        return None

    if sus["ultimo_aviso"] and not forzar:
        ultimo = datetime.fromisoformat(sus["ultimo_aviso"])
        if datetime.now(timezone.utc) - ultimo < timedelta(hours=HORAS_ENTRE_AVISOS):
            return None

    lugar = sus["nombre"].split(",")[0]
    notificar(sus["topic"], f"Va a dar la rebotá en {lugar}", detalle)
    with db() as c:
        c.execute("UPDATE suscriptores SET ultimo_aviso=? WHERE id=?",
                  (datetime.now(timezone.utc).isoformat(), sus["id"]))
    return detalle


def revisar_todos():
    with db() as c:
        subs = c.execute("SELECT * FROM suscriptores").fetchall()
    for s in subs:
        try:
            res = revisar(s)
            print(f"[{datetime.now():%Y-%m-%d %H:%M}] {s['nombre']}: {'AVISO - ' + res if res else 'sin aviso'}")
        except Exception as e:  # un fallo con un suscriptor no debe parar al resto
            print(f"[{datetime.now():%Y-%m-%d %H:%M}] {s['nombre']}: error {e}")


# ---------------------------------------------------------------- Web
BASE = """<!doctype html><html lang="es"><head><meta charset="utf-8">
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
{{ cuerpo|safe }}</main></body></html>"""


def pagina(cuerpo, **ctx):
    return render_template_string(BASE, cuerpo=render_template_string(cuerpo, **ctx))


FORM_UBICACION = """
 <form method="post" action="{{ url_for('buscar') }}">
  <input type="text" name="q" placeholder="Tu localidad (p. ej. Las Rozas)" required>
  <button>Buscar</button>
 </form>
 <form method="get" action="{{ url_for('consulta') }}" id="geo">
  <input type="hidden" name="lat"><input type="hidden" name="lon">
  <input type="hidden" name="nombre" value="Tu ubicación">
  <button type="button" class="sec" onclick="usarUbicacion()">📍 Usar mi ubicación actual</button>
 </form>
<script>
function usarUbicacion(){
  if(!navigator.geolocation){alert('Tu navegador no permite la geolocalización');return;}
  navigator.geolocation.getCurrentPosition(p=>{
    const f=document.getElementById('geo');
    f.lat.value=p.coords.latitude.toFixed(4);f.lon.value=p.coords.longitude.toFixed(4);f.submit();
  },()=>alert('No se pudo obtener la ubicación'));
}
</script>"""


@app.get("/")
def inicio():
    return pagina("""
<div class="card">
 <h1>¿Va a dar la rebotá?</h1>
 <p class="sub">Dinos dónde estás y te decimos si en las próximas 24 horas la temperatura va a caer {{u}} °C o más respecto al día anterior.</p>
""" + FORM_UBICACION + """
</div>""", u=f"{UMBRAL_C:g}")


@app.post("/buscar")
def buscar():
    q = request.form.get("q", "").strip()
    try:
        res = geocodificar(q) if q else []
    except requests.RequestException:
        res = None
    return pagina("""
<div class="card">
 <h1>¿Dónde exactamente?</h1>
 {% if res is none %}<p>No se pudo consultar el buscador. Inténtalo de nuevo en un momento.</p>
 {% elif not res %}<p>No he encontrado «{{q}}».</p>
 {% else %}{% for r in res %}
  <a class="btn opt" href="{{ url_for('consulta', lat=r.lat, lon=r.lon, nombre=r.nombre) }}">{{r.nombre}}</a>
 {% endfor %}{% endif %}
 <a class="btn sec" href="{{ url_for('inicio') }}">Volver</a>
</div>""", res=res, q=q)


def coordenadas(form):
    try:
        lat, lon = float(form["lat"]), float(form["lon"])
    except (KeyError, ValueError):
        abort(400)
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        abort(400)
    return lat, lon, form.get("nombre", "Tu ubicación")[:120]


@app.get("/consulta")
def consulta():
    lat, lon, nombre = coordenadas(request.args)
    try:
        tiempos, temps, ahora = pronostico(lat, lon)
        si, titular, detalle = veredicto(analizar(tiempos, temps, ahora), ahora)
    except requests.RequestException:
        si, titular, detalle = None, "No lo sé", "No se pudo consultar el pronóstico. Inténtalo de nuevo en un momento."
    return pagina("""
<div class="resp {{ 'si' if si else 'no' }}">
 <div class="lugar">¿Va a dar la rebotá en {{nombre}}?</div>
 <div class="big">{{titular}}</div>
 <p class="det">{{detalle}}</p>
</div>
<div class="card">
 <h1 style="font-size:1.25rem">Que te avise RebotApp</h1>
 <p class="sub">Revisamos el pronóstico a las {{horas}} h y te mandamos una notificación al móvil cuando vaya a dar la rebotá aquí.</p>
 <form method="post" action="{{ url_for('alta') }}">
  <input type="hidden" name="lat" value="{{lat}}"><input type="hidden" name="lon" value="{{lon}}">
  <input type="hidden" name="nombre" value="{{nombre}}">
  <button>🔔 Avísame</button>
 </form>
 <a class="btn sec" href="{{ url_for('inicio') }}">Consultar otro sitio</a>
</div>""", si=si, titular=titular, detalle=detalle, nombre=nombre, lat=lat, lon=lon,
                  horas=HORAS_REVISION.replace(",", " y "))


@app.post("/alta")
def alta():
    lat, lon, nombre = coordenadas(request.form)
    topic, token = "rebota-" + secrets.token_urlsafe(12), secrets.token_urlsafe(16)
    with db() as c:
        c.execute("INSERT INTO suscriptores (nombre,lat,lon,topic,token,creado) VALUES (?,?,?,?,?,?)",
                  (nombre, lat, lon, topic, token, datetime.now(timezone.utc).isoformat()))
    return redirect(url_for("listo", token=token))


def suscriptor(token):
    with db() as c:
        s = c.execute("SELECT * FROM suscriptores WHERE token=?", (token,)).fetchone()
    if not s:
        abort(404)
    return s


@app.get("/s/<token>")
def listo(token):
    s = suscriptor(token)
    return pagina("""
<div class="card">
 <h1>✅ Aviso activado</h1>
 <p class="sub">{{s.nombre}}</p>
 <ol>
  <li>Instala la app gratuita <b>ntfy</b> (Android o iPhone).</li>
  <li>Pulsa <b>+</b> y suscríbete a este canal:<br><code>{{s.topic}}</code></li>
  <li>Comprueba que funciona: <form method="post" action="{{ url_for('prueba', token=s.token) }}" style="display:inline">
      <button>Enviar notificación de prueba</button></form></li>
 </ol>
 <p><a class="btn sec" href="{{ntfy}}/{{s.topic}}" target="_blank">Abrir el canal en el navegador</a>
    <a class="btn sec" href="{{ url_for('consulta', lat=s.lat, lon=s.lon, nombre=s.nombre) }}">¿Va a dar hoy?</a></p>
 <small>Guarda esta página: es tu enlace para gestionar el aviso. RebotApp revisa el pronóstico a las {{horas}} h.</small>
</div>
<div class="card">
 <form method="post" action="{{ url_for('baja', token=s.token) }}" onsubmit="return confirm('¿Desactivar el aviso?')">
  <button class="sec">Darme de baja</button>
 </form>
</div>""", s=s, ntfy=NTFY_SERVER, horas=HORAS_REVISION.replace(",", " y "))


@app.post("/s/<token>/prueba")
def prueba(token):
    s = suscriptor(token)
    try:
        notificar(s["topic"], "RebotApp funciona",
                  f"Te avisaré cuando vaya a dar la rebotá en {s['nombre'].split(',')[0]}.",
                  prioridad=3, tags=("white_check_mark",))
    except requests.RequestException:
        pass
    return redirect(url_for("listo", token=token))


@app.post("/s/<token>/baja")
def baja(token):
    suscriptor(token)
    with db() as c:
        c.execute("DELETE FROM suscriptores WHERE token=?", (token,))
    return pagina('<div class="card"><h1>Aviso desactivado</h1>'
                  '<a class="btn sec" href="{{ url_for(\'inicio\') }}">Volver a RebotApp</a></div>')


# ---------------------------------------------------------------- Arranque
def arrancar_programador():
    from apscheduler.schedulers.background import BackgroundScheduler
    sched = BackgroundScheduler(timezone=ZONA_PROGRAMADOR)
    sched.add_job(revisar_todos, "cron", hour=HORAS_REVISION, minute=0)
    sched.start()


MODO_REVISAR = __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] == "revisar"

os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
init_db()

# Se arranca al importar para que funcione igual con `python app.py` que con
# gunicorn (usar un solo worker: `gunicorn -w 1 ...`, o se duplicarían avisos).
if ACTIVAR_PROGRAMADOR and not MODO_REVISAR:
    arrancar_programador()

if __name__ == "__main__":
    if MODO_REVISAR:
        revisar_todos()
    else:
        app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
