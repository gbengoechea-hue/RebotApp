# RebotApp — ¿Va a dar la rebotá?

La **rebotá** es una caída brusca de la temperatura: que en las próximas 24 horas alguna hora vaya a estar **8 °C o más** por debajo de la misma hora del día anterior.

RebotApp es una web que cualquiera puede usar desde un enlace: indica su localidad (o usa la ubicación del móvil), ve al momento si va a dar la rebotá y, si quiere, activa un aviso.

Funciona gratis en **Cloudflare Workers**:

- Pronóstico: [Open-Meteo](https://open-meteo.com) (gratuito, sin clave).
- Revisión automática a las 8:00 y a las 20:00, hora de Madrid (respeta el cambio de hora).
- Suscripciones guardadas en el almacenamiento SQLite integrado del Worker. No hay que crear ninguna base de datos.

## Formas de recibir el aviso

| Canal | Qué necesita quien se suscribe | Coste |
|---|---|---|
| **Notificaciones del navegador** | Pulsar «Activar notificaciones». En iPhone, antes: Safari → Compartir → *Añadir a pantalla de inicio* y abrir RebotApp desde ese icono | Gratis, sin servicios externos |
| **Correo electrónico** | Escribir su correo y confirmar el enlace que recibe | Gratis con Brevo (300 correos/día) |
| **ntfy** (opcional) | Tener la app ntfy | Gratis |

Las claves de las notificaciones del navegador las genera y guarda la propia app la primera vez; no hay que configurar nada. El correo solo aparece si están configurados los secretos de Brevo (ver abajo).

## Cómo decide si va a dar la rebotá

Para cada hora de las próximas 24 h compara la temperatura prevista con la de **la misma hora del día anterior**. Así no salta por el enfriamiento normal de la noche (en Madrid es habitual bajar 12–15 °C de la tarde a la madrugada) y sí salta con frentes fríos, DANAs o entradas de aire polar. Tras un aviso, no repite durante 18 h.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.js` | La app: web, cálculo de la rebotá y avisos |
| `iconos.js` | El icono de la app (para la pantalla de inicio y las notificaciones) |
| `wrangler.toml` | Configuración para Cloudflare (nombre, horario, almacenamiento) |
| `package.json` | Indica a Cloudflare qué herramienta usar para publicarla |
| `README.md` | Estas instrucciones |

## Publicarla en Cloudflare (gratis, sin tarjeta)

1. **GitHub**: sube los archivos a la raíz del repositorio RebotApp.
2. **Cuenta**: regístrate en dash.cloudflare.com (plan Free).
3. **Workers & Pages** → **Create application** → junto a **Import a repository**, **Get started** → conecta GitHub y elige el repositorio.
4. El nombre del proyecto debe ser exactamente **`rebotapp`** (igual que en `wrangler.toml`). Pulsa **Save and Deploy**.

Cada cambio que hagas después en GitHub se publica solo.

## Activar el correo (opcional)

1. Crea una cuenta gratuita en **brevo.com**.
2. **Remitente**: en el menú de tu cuenta → *Senders, Domains & Dedicated IPs* → *Senders* → *Add a sender*. Pon "RebotApp" y tu correo; Brevo te manda un código para verificarlo.
3. **Clave**: menú de tu cuenta → *SMTP & API* → pestaña *API Keys* → *Generate a new API key*. Cópiala (solo se muestra una vez).
4. En **Cloudflare** → Workers & Pages → `rebotapp` → **Settings** → **Variables and Secrets** → **Add**, y crea dos, ambas de tipo **Secret**:
   - `BREVO_API_KEY` = la clave de Brevo
   - `EMAIL_REMITENTE` = el correo que verificaste en el paso 2
5. Pulsa **Deploy** para guardar. En la página de cada aviso aparecerá la opción «Avisarme por correo».

Los secretos no se guardan en GitHub, así que la clave queda privada aunque el repositorio sea público. Los primeros correos pueden llegar a spam hasta que se marquen como «no es spam».

## Cambiar ajustes

En `wrangler.toml`, sección `[vars]`:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `UMBRAL_C` | `8` | Grados de caída para que dé la rebotá |
| `HORAS_REVISION` | `8,20` | Horas locales de revisión |
| `ZONA` | `Europe/Madrid` | Zona horaria de esas horas |
| `HORAS_ENTRE_AVISOS` | `18` | Silencio tras un aviso |
| `NTFY_SERVER` | `https://ntfy.sh` | Servidor de ntfy |

Opcional, como secreto o variable: `EMAIL_NOMBRE` (nombre del remitente, por defecto "RebotApp").

## Límites del plan gratuito

100.000 visitas al día en Cloudflare y 50 envíos externos por revisión. Los pronósticos se piden en lotes de 50 ubicaciones y, si un día tocara avisar a muchísima gente a la vez, los pendientes se avisan media hora después. Brevo gratis: 300 correos al día. De sobra para familia, amigos y varios cientos de suscriptores.

## Privacidad

- Los correos solo se usan para los avisos y se activan con doble confirmación (nadie puede apuntar el correo de otro). Cada correo lleva el enlace para quitarlo.
- Las notificaciones del navegador van cifradas de extremo a extremo hasta el dispositivo.
- Los canales de ntfy.sh son públicos para quien conozca su nombre (aleatorio): los avisos no contienen datos personales.

## Probar en local (opcional, para programadores)

```bash
npm install
npx wrangler dev --test-scheduled --var REVISAR_SIEMPRE:1
# revisión forzada: curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```
