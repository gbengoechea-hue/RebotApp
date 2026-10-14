# RebotApp — ¿Va a dar la rebotá?

La **rebotá** es una caída brusca de la temperatura: que en las próximas 24 horas alguna hora vaya a estar **8 °C o más** por debajo de la misma hora del día anterior.

RebotApp es una web que cualquiera puede usar desde un enlace: indica su localidad (o usa la ubicación del móvil), ve al momento si va a dar la rebotá y, si quiere, activa un aviso para recibir una notificación en el móvil cada vez que vaya a dar.

Funciona gratis en **Cloudflare Workers**:

- Pronóstico: [Open-Meteo](https://open-meteo.com) (gratuito, sin clave).
- Avisos: [ntfy](https://ntfy.sh) (app gratuita para Android e iPhone, sin registro).
- Revisión automática a las 8:00 y a las 20:00, hora de Madrid (respeta el cambio de hora).
- Suscripciones guardadas en el almacenamiento SQLite integrado del Worker. No hay que crear ninguna base de datos.

## Cómo decide si va a dar la rebotá

Para cada hora de las próximas 24 h compara la temperatura prevista con la de **la misma hora del día anterior**. Así no salta por el enfriamiento normal de la noche (en Madrid es habitual bajar 12–15 °C de la tarde a la madrugada) y sí salta con frentes fríos, DANAs o entradas de aire polar. Tras un aviso, no repite durante 18 h.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `index.js` | La app: web, cálculo de la rebotá y avisos |
| `wrangler.toml` | Configuración para Cloudflare (nombre, horario, almacenamiento) |
| `package.json` | Indica a Cloudflare qué herramienta usar para publicarla |
| `README.md` | Estas instrucciones |

## Publicarla en Cloudflare (gratis, sin tarjeta)

1. **GitHub**: en el repositorio RebotApp, borra los archivos de la versión anterior (`app.py`, `requirements.txt`, `render.yaml`) y sube estos cuatro a la raíz.
2. **Cuenta**: regístrate en dash.cloudflare.com con correo y contraseña (plan Free).
3. En el menú de la izquierda entra en **Workers & Pages** (en algunos paneles aparece dentro de *Compute*) → **Create application**.
4. Junto a **Import a repository** pulsa **Get started**, conecta tu cuenta de **GitHub** (puedes darle acceso solo a RebotApp) y elige el repositorio.
5. En la configuración, el nombre del proyecto debe ser exactamente **`rebotapp`** (igual que en `wrangler.toml`; si no coincide, falla). El resto de opciones déjalas como vienen; si te pide un comando de despliegue, pon `npx wrangler deploy`.
6. Pulsa **Save and Deploy**. En uno o dos minutos tendrás la dirección `https://rebotapp.<tu-subdominio>.workers.dev`. Ese es el enlace para compartir.
7. Entra, consulta tu localidad, pulsa **Avísame** y luego **Enviar notificación de prueba**.

A partir de ahí, cada cambio que hagas en GitHub se publica solo.

## Cambiar ajustes

En `wrangler.toml`, sección `[vars]`:

| Variable | Por defecto | Qué hace |
|---|---|---|
| `UMBRAL_C` | `8` | Grados de caída para que dé la rebotá |
| `HORAS_REVISION` | `8,20` | Horas locales de revisión |
| `ZONA` | `Europe/Madrid` | Zona horaria de esas horas |
| `HORAS_ENTRE_AVISOS` | `18` | Silencio tras un aviso |
| `NTFY_SERVER` | `https://ntfy.sh` | Servidor de notificaciones |

## Límites del plan gratuito

100.000 visitas al día y 50 consultas externas por revisión. Los pronósticos se piden en lotes de 50 ubicaciones y, si un día tocara avisar a muchísima gente a la vez, los pendientes se avisan media hora después. De sobra para uso personal, familia y amigos, e incluso varios cientos de suscriptores.

## Privacidad

Cada suscriptor recibe un canal ntfy aleatorio difícil de adivinar, pero los canales de ntfy.sh son públicos para quien conozca su nombre: los avisos no contienen datos personales, solo la localidad y la temperatura.

## Probar en local (opcional, para programadores)

```bash
npm install
npx wrangler dev --test-scheduled
# revisión forzada: curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*" (con --var REVISAR_SIEMPRE:1)
```
